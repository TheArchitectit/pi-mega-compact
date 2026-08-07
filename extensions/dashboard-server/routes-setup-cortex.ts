/**
 * dashboard-server/routes-setup-cortex.ts — VC9A Setup Cortex status route.
 *
 *   GET /api/setup-cortex-status — reader-only aggregate surfacing the
 *        vector-cortex encoder gate (mode A/B/C, qualification verdict,
 *        blockers, encoder health) for the dashboard Setup tab. Does NOT close
 *        the ML gate: the hard-gate blockers are read-only and stay open.
 *
 * Reuses readEncoderManifest / verifyEncoderAsset / detectPlatform
 * (src/vector-cortex/encoder/asset.ts) and deriveVcStatus (vc-status.ts),
 * plus the memoized encoder-facts pattern from routes-vector-cortex-health.ts
 * (manifest bytes + file size/mtime + platform cache key) so the expensive
 * full-asset hashing is skipped on repeat polls.
 *
 * The blocker rows carry NO string literals here — they come from the static
 * manifest module setup-cortex-blockers.ts (single canonical source).
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate (never payloads/prompts/ledger — EVAL-REDACT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "./routes-core.js";
import { VC9A_ENABLED, ENC_0E_ENABLED, ENC_0F_ENABLED, ENC_0G_ENABLED } from "../../src/config.js";
import { readEncoderManifest, verifyEncoderAsset, detectPlatform } from "../../src/vector-cortex/encoder/asset.js";
import type { QualificationV1 } from "../../src/vector-cortex/encoder/qualify.js";
import { selectRuntimeBackend } from "../../src/vector-cortex/encoder/runtime-select.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { deriveVcStatus } from "./vc-status.js";
import { SETUP_CORTEX_BLOCKERS, computeSetupCortexBlockers } from "./setup-cortex-blockers.js";
import {
  readQualificationRecord,
  encoderStateDir,
  QUALIFICATION_RECORD_UNAVAILABLE,
} from "./qualification-record.js";
import type {
  SetupCortexStatusResponse,
  BlockerV1,
} from "./api-contracts/setup-cortex.js";

/** Resolve the committed encoder-v1 asset dir by walking up to the repo root. */
function encoderAssetDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("assets", "vector-cortex", "encoder-v1");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    try {
      // guardrails-allow PREVENT-PI-004: local asset filesystem read (loopback)
      readFileSync(join(candidate, "manifest.json"));
      return candidate;
    } catch {
      /* keep walking */
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** Reader-only encoder health facts: mode + asset digest (+ vertex/verdict). */
interface SetupCortexFacts {
  mode: "A" | "B" | "C";
  assetDigestPrefix: string | null;
  verdict: "qualified" | "demoted" | "unavailable";
  thresholdFailures: string[];
  /** Number of projection heads the verified manifest declares, or null. */
  headCount: number | null;
}

interface SetupCortexFactCache {
  key: string;
  facts: SetupCortexFacts;
}

let factCache: SetupCortexFactCache | null = null;

/** Stable cache key: manifest bytes + (size,mtime) of the asset files + platform. */
function factCacheKey(
  dir: string,
  manifestPath: string,
  stateDir: string,
  record: QualificationV1 | null,
  recordGate: boolean,
): string | null {
  const platform = detectPlatform();
  if (!platform) return null;
  const parts: string[] = [platform];
  try {
    for (const p of [manifestPath, join(dir, "model.onnx"), join(dir, "tokenizer.json")]) {
      const s = statSync(p);
      parts.push(`${s.size}:${s.mtimeMs}`);
    }
    // guardrails-allow PREVENT-PI-004: local manifest filesystem read (loopback)
    parts.push(createHash("sha256").update(readFileSync(manifestPath)).digest("hex"));
  } catch {
    return null;
  }
  // ENC-0g: fold the qualification-record gate + (mtime, content sha) into the
  // key so a re-run gate invalidates memoized facts (no stale verdict served).
  try {
    const s = statSync(join(stateDir, "encoder-qualification.json"));
    parts.push(`g:${recordGate ? "on" : "off"}`, `q:${s.size}:${s.mtimeMs}`);
    parts.push(createHash("sha256").update(JSON.stringify(record)).digest("hex"));
  } catch {
    parts.push(`g:${recordGate ? "on" : "off"}`, "q:absent");
  }
  return parts.join("|");
}

function applyQualificationOverride(
  base: SetupCortexFacts,
  record: QualificationV1 | null,
  recordGate: boolean,
): SetupCortexFacts {
  // Flag-off (recordGate false): byte-identical verify-derived facts.
  if (!recordGate) return base;
  if (record !== null) {
    // The ENC-0f QualificationV1 failure maps onto the contract "demoted": a
    // structurally-valid asset whose real-asset gate measured failure is honest
    // as demoted, NOT qualified. mode stays verify-derived (A).
    return {
      ...base,
      verdict: record.verdict === "qualified" ? "qualified" : "demoted",
      thresholdFailures: [...record.reasons],
    };
  }
  // No record + gate on: keep the verify verdict but surface the missing-record
  // sentinel (never a fabricated pass, never a bare silent fallback).
  return {
    ...base,
    thresholdFailures: [...base.thresholdFailures, QUALIFICATION_RECORD_UNAVAILABLE],
  };
}

function computeSetupCortexFacts(
  dir: string,
  stateDir: string,
  record: QualificationV1 | null,
  recordGate: boolean,
): SetupCortexFacts | null {
  const manifest = readEncoderManifest(dir);
  if (manifest === null) {
    return { mode: "C", assetDigestPrefix: null, verdict: "unavailable", thresholdFailures: [], headCount: null };
  }
  const headCount = Object.keys(manifest.heads).length;
  const manifestPath = join(dir, "manifest.json");
  const key = factCacheKey(dir, manifestPath, stateDir, record, recordGate);
  if (key === null) return null;
  if (factCache !== null && factCache.key === key) return factCache.facts;
  let digest: string;
  try {
    // guardrails-allow PREVENT-PI-004: local manifest filesystem read (loopback)
    digest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  } catch {
    const base: SetupCortexFacts = { mode: "B", assetDigestPrefix: null, verdict: "demoted", thresholdFailures: ["ENC_ASSET_UNREADABLE"], headCount };
    const facts = applyQualificationOverride(base, record, recordGate);
    factCache = { key, facts };
    return facts;
  }
  const verify = verifyEncoderAsset(dir, manifest, detectPlatform());
  const prefix = digest.slice(0, 12);
  const base: SetupCortexFacts = verify.ok
    ? { mode: "A", assetDigestPrefix: prefix, verdict: "qualified", thresholdFailures: [], headCount }
    : { mode: "B", assetDigestPrefix: prefix, verdict: "demoted", thresholdFailures: [verify.code], headCount };
  const facts = applyQualificationOverride(base, record, recordGate);
  factCache = { key, facts };
  return facts;
}

function setupCortexFacts(
  record: QualificationV1 | null,
  recordGate: boolean,
): SetupCortexFacts {
  const dir = encoderAssetDir();
  if (dir === null) {
    return { mode: "C", assetDigestPrefix: null, verdict: "unavailable", thresholdFailures: [], headCount: null };
  }
  const facts = computeSetupCortexFacts(dir, encoderStateDir(), record, recordGate);
  return facts ?? { mode: "C", assetDigestPrefix: null, verdict: "unavailable", thresholdFailures: [], headCount: null };
}

/**
 * Reader-only GET /api/setup-cortex-status (VC9A).
 *
 * Purely read: no mutation, never payloads/prompts/ledger. Flag-off returns the
 * byte-identical VC8C-era shape `{enabled:false, mode:"C", status:"off"}` with
 * the encoder-health mode C and no qualification/blocker detail leaked.
 */
export function handleSetupCortexStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/setup-cortex-status") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC9A_ENABLED();

  // ENC-0g: when both gates are ON, read the QualificationV1 record and let its
  // verdict override the structural verify for the `qualification` field. When
  // ENC_0G is OFF, nothing below reads the record (byte-identical to ENC-0f-era).
  const enc0g = enabled && ENC_0G_ENABLED();
  const recordGate = enc0g && ENC_0F_ENABLED();
  const record = recordGate ? readQualificationRecord(encoderStateDir()) : null;

  const facts = enabled ? setupCortexFacts(record, recordGate) : null;

  const blocks: BlockerV1[] = enabled
    ? enc0g
      ? [...computeSetupCortexBlockers({
          platform: detectPlatform(),
          qualification: record,
          headCount: facts ? facts.headCount : null,
        })]
      : [...SETUP_CORTEX_BLOCKERS]
    : [];

  // ENC-0e: surface the darwin-x64 demotion reason additively (reader-only GET,
  // no new route). The platform is read locally; the selection is pure. On a
  // non-darwin-x64 host or flag-off this is null and the field is omitted —
  // byte-compatible payload.
  const darwinX64 = enabled ? darwinX64StatusBlock() : null;

  const body: SetupCortexStatusResponse = {
    enabled,
    flag: "MEGACOMPACT_VC9A",
    mode: facts ? facts.mode : "C",
    assetDigestPrefix: facts ? facts.assetDigestPrefix : null,
    qualification: facts
      ? { verdict: facts.verdict, thresholdFailures: facts.thresholdFailures }
      : { verdict: "unavailable", thresholdFailures: [] },
    blockers: blocks,
    encoderHealth: facts
      ? { assetDigestPrefix: facts.assetDigestPrefix, mode: facts.mode }
      : { assetDigestPrefix: null, mode: "C" },
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled, hasData: !!facts && facts.verdict !== "unavailable", structuralOnly: true }),
    ...(darwinX64 !== null ? { darwinX64 } : {}),
  };

  sendJson(res, 200, body);
  return true;
}

/**
 * ENC-0e helper: the darwin-x64 demotion block for the setup-cortex status
 * response. Exported for direct unit assertion without a live HTTP round-trip —
 * returns null on any non-darwin-x64 platform or flag-off (so the additive
 * contract field is omitted from the payload, byte-compatible). The demotion
 * reason flows from the pure `selectRuntimeBackend` selection, never a literal
 * in the route.
 */
export function darwinX64StatusBlock(): {
  demoted: boolean;
  reason: string | undefined;
} | null {
  const platform = detectPlatform();
  if (platform !== "darwin-x64" || !ENC_0E_ENABLED()) return null;
  const chosen = selectRuntimeBackend({
    platform,
    benchRecord: null,
    nativeOptIn: process.env.MEGACOMPACT_ENCODER_NATIVE === "1",
  });
  return {
    demoted: chosen.backend === "wasm",
    reason: chosen.demotionReason ?? undefined,
  };
}
