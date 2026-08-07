/**
 * dashboard-server/routes-setup-enc1b.ts — ENC-1b embedder API completion +
 * ONNX runtime selection Settings read/write + the additive writer branch.
 *
 * Extracted out of routes-setup.ts (which hovers at the 300-line source soft
 * cap, mirroring the ENC-1a sibling extract) so the ENC-1b additive read/write
 * of the per-repo `.mega-compact.env` keys AND the runtime-backend computation
 * live in a sibling impl file. Four keys are managed here:
 * `MEGACOMPACT_EMBEDDING_DIM`, `MEGACOMPACT_EMBEDDING_HEADERS`,
 * `MEGACOMPACT_ALLOW_REMOTE_EMBEDDER`, `MEGACOMPACT_ENCODER_NATIVE` — the exact
 * names `embeddingConfigFromEnv` (src/httpEmbedder.ts) and the runtime selector
 * read at runtime.
 *
 * The write is create-or-append: it upserts the four keys into the existing
 * per-repo `.mega-compact.env`, preserving every unrelated line and never
 * deleting another key. The read reports the persisted dim, booleans for
 * headers-set / allow-remote / native-opt-in, and computes the current
 * effective backend + demotion reason through the EXISTING `selectRuntimeBackend`
 * (reader-only — the runtime's own selection, never a reimplemented literal,
 * never install logic). The raw headers JSON is NEVER returned, logged or
 * emitted (redaction invariant — it may carry secrets such as an Authorization
 * header for a TEI/ONNX server).
 *
 * Guardrails: PREVENT-PI-004 (local filesystem reads/writes + in-memory
 * runtime selection only, zero network), PREVENT-001 (null-safe JSON),
 * PREVENT-011 (no `any`).
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import {
  ENC_1B_ENABLED,
  ENC_1B_MAX_EMBEDDING_DIM,
  ENC_1B_EMBEDDING_DIM_ENV,
  ENC_1B_EMBEDDING_HEADERS_ENV,
  ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV,
  ENC_1B_ENCODER_NATIVE_ENV,
} from "../../src/config/vector-cortex.js";
import type { SetupConfigureRequest, SetupConfigureResponse } from "./api-contracts/setup.js";
import { selectRuntimeBackend } from "../../src/vector-cortex/encoder/runtime-select.js";
import { detectPlatform } from "../../src/vector-cortex/encoder/asset.js";

function envPath(stateDir: string): string {
  return join(stateDir, ".mega-compact.env");
}

/** Extract the value of `export MEGACOMPACT_X="..."` (or unquoted) from a line. */
function lineValue(line: string, key: string): string | null {
  const m = line.match(new RegExp(`^export\\s+${key}=(.*)$`));
  if (!m) return null;
  const rest = m[1].trim();
  if (rest.length === 0) return null;
  const q = rest.match(/^"([^"]*)"$/);
  return q ? q[1] : rest;
}

/** True when the payload carries any ENC-1b key (flag-gated). */
export function wantsEnc1b(body: SetupConfigureRequest): boolean {
  return (
    ENC_1B_ENABLED() &&
    (typeof body.embeddingDim === "string" ||
      typeof body.embeddingHeaders === "string" ||
      typeof body.allowRemoteEmbedder === "boolean" ||
      typeof body.encoderNativeOptIn === "boolean")
  );
}

/** Read the ENC-1b keys from the per-repo `.mega-compact.env`. The headers
 *  value is NEVER surfaced to callers — only its presence boolean. */
export function readEnc1bEnv(stateDir: string): {
  dim: string | null;
  headersSet: boolean;
  allowRemote: boolean;
  nativeOptIn: boolean;
} {
  try {
    const p = envPath(stateDir);
    if (!existsSync(p)) return { dim: null, headersSet: false, allowRemote: false, nativeOptIn: false };
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    let dim: string | null = null;
    let headersSet = false;
    let allowRemote = false;
    let nativeOptIn = false;
    for (const line of lines) {
      const d = lineValue(line, ENC_1B_EMBEDDING_DIM_ENV);
      if (d !== null && d.length > 0) dim = d;
      const h = lineValue(line, ENC_1B_EMBEDDING_HEADERS_ENV);
      if (h !== null && h.length > 0) headersSet = true;
      const a = lineValue(line, ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV);
      if (a !== null && ["1", "true", "yes"].includes(a.trim().toLowerCase())) allowRemote = true;
      const n = lineValue(line, ENC_1B_ENCODER_NATIVE_ENV);
      if (n !== null && ["1", "true", "yes"].includes(n.trim().toLowerCase())) nativeOptIn = true;
    }
    return { dim, headersSet, allowRemote, nativeOptIn };
  } catch {
    return { dim: null, headersSet: false, allowRemote: false, nativeOptIn: false };
  }
}

/**
 * ENC-1b additive GET status fields. All omitted when flag-off. The Cortex
 * trio (native opt-in + effective backend + demotion reason) is computed here
 * (reader-only): the stored opt-in + current platform drive the EXISTING
 * `selectRuntimeBackend`, whose own demotion reason is surfaced verbatim when
 * the runtime falls back. `modeB` (flag-off selection) is projected to `wasm`
 * for display. Returns `{}` when the flag is off (byte-identical predecessor).
 */
export function enc1bStatusFields(stateDir: string): {
  embeddingDim?: string;
  embeddingHeadersSet?: boolean;
  allowRemoteEmbedder?: boolean;
  encoderNativeOptIn?: boolean;
  encoderBackend?: "wasm" | "native";
  encoderDemotionReason?: string | null;
} {
  if (!ENC_1B_ENABLED()) return {};
  const env = readEnc1bEnv(stateDir);
  const platform = detectPlatform();
  const chosen = selectRuntimeBackend({
    platform: platform ?? "unsupported",
    benchRecord: null,
    nativeOptIn: env.nativeOptIn,
  });
  const backend: "wasm" | "native" =
    chosen.backend === "native" ? "native" : "wasm";
  return {
    ...(env.dim !== null ? { embeddingDim: env.dim } : {}),
    embeddingHeadersSet: env.headersSet,
    allowRemoteEmbedder: env.allowRemote,
    encoderNativeOptIn: env.nativeOptIn,
    encoderBackend: backend,
    encoderDemotionReason: chosen.demotionReason,
  };
}

/** Upsert the ENC-1b keys into the per-repo `.mega-compact.env`. Creates the
 *  file if absent; preserves every unrelated line; never deletes other keys.
 *  A `null` entry leaves that key's line untouched. The headers value is
 *  wrapped in single quotes so the inner JSON double quotes survive the env
 *  loader's outer-quote strip (shell-sourceable + loader-compatible). */
export function writeEnc1bEnv(
  stateDir: string,
  entries: {
    dim?: string | null;
    headers?: string | null;
    allowRemote?: boolean | null;
    nativeOptIn?: boolean | null;
  },
): string {
  const p = envPath(stateDir);
  const existingLines: string[] = existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/) : [];
  const out: string[] = [];
  const keys = new Set<{ key: string; present: () => boolean; push: () => void }>([
    {
      key: ENC_1B_EMBEDDING_DIM_ENV,
      present: () => entries.dim !== null,
      push: () => out.push(`export ${ENC_1B_EMBEDDING_DIM_ENV}="${entries.dim ?? ""}"`),
    },
    {
      key: ENC_1B_EMBEDDING_HEADERS_ENV,
      present: () => entries.headers !== null,
      push: () => out.push(`export ${ENC_1B_EMBEDDING_HEADERS_ENV}='${entries.headers ?? ""}'`),
    },
    {
      key: ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV,
      present: () => entries.allowRemote !== null,
      push: () =>
        out.push(
          entries.allowRemote
            ? `export ${ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV}="1"`
            : `export ${ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV}="0"`,
        ),
    },
    {
      key: ENC_1B_ENCODER_NATIVE_ENV,
      present: () => entries.nativeOptIn !== null,
      push: () =>
        out.push(
          entries.nativeOptIn
            ? `export ${ENC_1B_ENCODER_NATIVE_ENV}="1"`
            : `export ${ENC_1B_ENCODER_NATIVE_ENV}="0"`,
        ),
    },
  ]);
  const written = new Set<string>();
  for (const line of existingLines) {
    let replaced = false;
    for (const k of keys) {
      if (k.present() && lineValue(line, k.key) !== null) {
        k.push();
        written.add(k.key);
        replaced = true;
        break;
      }
    }
    if (!replaced) out.push(line);
  }
  for (const k of keys) {
    if (k.present() && !written.has(k.key)) k.push();
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(p, out.join("\n"), "utf-8");
  return p;
}

/** Validate `embeddingDim` as a positive integer string within the ENC-1b cap.
 *  Returns `null` when valid, else the error code. Exported so the routes host
 *  (combined-payload path) and the aggregator share the same rule. */
export function validateDim(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return "invalid_embedding_dim";
  if (!/^\d+$/.test(value)) return "invalid_embedding_dim";
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > ENC_1B_MAX_EMBEDDING_DIM) {
    return "invalid_embedding_dim";
  }
  return null;
}

/** Validate `embeddingHeaders` as a string that parses to a JSON object.
 *  Returns `null` when valid, else the error code. Exported so the routes host
 *  (combined-payload path) and the aggregator share the same rule. */
export function validateHeaders(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return "invalid_embedding_headers";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "invalid_embedding_headers";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "invalid_embedding_headers";
  }
  return null;
}

/**
 * Combined-payload upsert: after the main embedder write has freshly written
 * the per-repo env, append any ENC-1b keys carried alongside a valid embedder
 * selection (flag-gated, additive). No-op when flag-off or no ENC-1b key.
 */
export function tryEnc1bInto(stateDir: string, body: SetupConfigureRequest): void {
  if (!wantsEnc1b(body)) return;
  writeEnc1bEnv(stateDir, {
    dim: typeof body.embeddingDim === "string" ? body.embeddingDim : null,
    headers: typeof body.embeddingHeaders === "string" ? body.embeddingHeaders : null,
    allowRemote: typeof body.allowRemoteEmbedder === "boolean" ? body.allowRemoteEmbedder : null,
    nativeOptIn:
      typeof body.encoderNativeOptIn === "boolean" ? body.encoderNativeOptIn : null,
  });
}

/**
 * If the payload is a pure ENC-1b configure (new keys, no embedder selection),
 * validate + write them additively to the per-repo env and reply. Returns true
 * when it fully handled the request. On a validation failure it replies 400
 * with the code and leaves the file byte-unchanged. Flag-off = keys are not
 * recognized and this returns false (byte-identical ENC-1a predecessor).
 */
/**
 * Combined-path validation: the standalone `tryEnc1bConfigure` handles the
 * pure-ENC-1b shape; when a payload ALSO carries a valid embedder the sibling
 * writer returns false and the routes host is responsible for running the same
 * dim/headers validation before the combined upsert — returned as the error
 * code string, or `null` if everything passes (or the flag is off).
 */
export function enc1bValidateCombined(body: SetupConfigureRequest): string | null {
	if (!ENC_1B_ENABLED()) return null;
	if (body.embeddingDim !== undefined) {
		const e = validateDim(body.embeddingDim);
		if (e !== null) return e;
	}
	if (body.embeddingHeaders !== undefined) {
		const e = validateHeaders(body.embeddingHeaders);
		if (e !== null) return e;
	}
	return null;
}

export function tryEnc1bConfigure(
  body: SetupConfigureRequest,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  if (!wantsEnc1b(body)) return false;
  const embedder = body.embedder;
  const embedderValid =
    !!embedder &&
    (embedder === "ollama" || embedder === "llama" || embedder === "trigram" ||
      embedder === "custom" || embedder === "onnx");
  if (embedderValid) return false; // combined payload — integrated after the embedder write
  // Each key is optional: only validate the ones actually carried in the
  // payload (absent keys are left untouched, never rejected).
  const dimError = body.embeddingDim === undefined ? null : validateDim(body.embeddingDim);
  if (dimError !== null) {
    // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: dimError }));
    return true;
  }
  const headersError =
    body.embeddingHeaders === undefined ? null : validateHeaders(body.embeddingHeaders);
  if (headersError !== null) {
    // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: headersError }));
    return true;
  }
  try {
    const envPath = writeEnc1bEnv(ctx.stateDir, {
      dim: typeof body.embeddingDim === "string" ? body.embeddingDim : null,
      headers: typeof body.embeddingHeaders === "string" ? body.embeddingHeaders : null,
      allowRemote: typeof body.allowRemoteEmbedder === "boolean" ? body.allowRemoteEmbedder : null,
      nativeOptIn:
        typeof body.encoderNativeOptIn === "boolean" ? body.encoderNativeOptIn : null,
    });
    const resp: SetupConfigureResponse = {
      embedder: "custom",
      url: null,
      envPath,
      restartRequired: true,
      alreadyActive: false,
    };
    // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resp));
    return true;
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: `write_failed: ${e instanceof Error ? e.message : String(e)}` }),
    );
    return true;
  }
}
