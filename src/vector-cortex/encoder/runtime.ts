/**
 * vector-cortex/encoder/runtime.ts — VC2A EncoderRuntime (task 3).
 *
 * Allocates (prepares an inference session) ONLY after manifest verification;
 * rejects any non (batch 1, tokens <= maxTokens, <=512) input with
 * ENC_SHAPE_INVALID; caps measured RSS at 150 MiB (ENC_RSS_BUDGET_EXCEEDED ->
 * mode B); and yields a deterministic mode-A inference over the verified asset
 * (the trained weights are substituted in VC2C — the contract, shape gating and
 * budgets all land here).
 *
 * Triad: A = qualified local ONNX (verified); B = asset-free trigram (forced by
 * a missing/unsupported/digest-bad asset, no remote fetch); C = lexical forced
 * when A verification fails AND B initialization itself fails. Demotions always
 * select B/C locally and never attempt a network fetch (PREVENT-PI-004).
 *
 * Pi-agnostic. No `any` (PREVENT-011). Emits the two VC2A events via the
 * reporter (non-fatal).
 */

import {
  detectPlatform,
  readEncoderManifest,
  verifyEncoderAsset,
  type AssetVerifyResult,
} from "./asset.js";
import { createEncoderReporter, type EncoderReporter } from "./emit.js";
import {
  ENC_FAIL,
  ENCODER_MAX_TOKENS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_SEMANTIC_WIDTH,
  type EncoderInferResult,
  type EncoderInput,
  type EncoderLoadResult,
  type EncoderMode,
  type EncoderRuntime,
} from "./types.js";

/** Injectable seam for RSS + allocator + clock so tests can drive failures. */
export interface RuntimeHost {
  readonly rssBytes: () => number;
  readonly allocatorFails: () => boolean;
  readonly nowMs: () => number;
}

const DEFAULT_HOST: RuntimeHost = {
  rssBytes: () => process.memoryUsage().rss,
  allocatorFails: () => false,
  nowMs: () => Date.now(),
};

export interface CreateEncoderRuntimeOptions {
  readonly reporter?: EncoderReporter;
  readonly host?: Partial<RuntimeHost>;
  /** Force the rollback path: load() always returns mode C without verifying
   *  any asset (byte-identical to the pre-triad derived pointer). A/B forcing
   *  is intentionally not offered — those are reached by verification outcome,
   *  not by fiat. */
  readonly forcedMode?: "C";
  /** Override the platform detector (tests / cross-platform demotion). */
  readonly platform?: () => ReturnType<typeof detectPlatform>;
}

function mergeHost(partial?: Partial<RuntimeHost>): RuntimeHost {
  return { ...DEFAULT_HOST, ...partial };
}

/** A deterministic seeded projection so the mode-A inference path is testable
 *  end-to-end without onnxruntime (real weights + execution are VC2C). */
function projectSemantic(seed: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let state = (seed >>> 0) ^ 0x9e3779b9;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state / 4294967296) * 2 - 1;
    sum += out[i]! * out[i]!;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < n; i++) out[i] = out[i]! / norm;
  return out;
}

/** Deterministic token seed derived from the verified asset bytes count. */
function seedFromBytes(embeddedBytes: number): number {
  return (embeddedBytes * 2654435761) >>> 0;
}

function modeLabel(mode: EncoderMode): string {
  return mode === "A" ? "qualified-onnx" : mode === "B" ? "trigram" : "lexical";
}

export function createEncoderRuntime(
  options: CreateEncoderRuntimeOptions = {},
): EncoderRuntime {
  const reporter = options.reporter ?? createEncoderReporter();
  const host = mergeHost(options.host);
  const forced = options.forcedMode;
  const plat = options.platform ?? detectPlatform;

  let mode: EncoderMode = forced ?? "C";
  let embeddedBytes = 0;
  let verified = false;

  const demote = (code: string, rmode: "B" | "C"): EncoderLoadResult => {
    mode = rmode;
    verified = false;
    reporter.runtimeDemoted({ reason: code, mode: rmode, platform: plat()?.toString() ?? "unsupported" });
    return { ok: false, mode: rmode, code };
  };

  const runtime: EncoderRuntime = {
    schema: "encoder-runtime-v1",
    // Live getter so `mode` always reflects the latest load/demote outcome
    // (a plain property would freeze at its construction-time value forever).
    get mode(): EncoderMode {
      return mode;
    },
    load(assetDir: string): EncoderLoadResult {
      if (forced === "C") {
        // Rollback path: mode C restores the prior derived pointer; no emission.
        mode = "C";
        verified = false;
        return { ok: false, mode: "C", code: ENC_FAIL.MANIFEST_INVALID };
      }
      // Attempt A: verify the local qualified ONNX asset (never a remote fetch).
      const manifest = readEncoderManifest(assetDir);
      let verify: AssetVerifyResult;
      if (manifest === null) {
        verify = { ok: false, code: ENC_FAIL.MANIFEST_INVALID };
      } else {
        verify = verifyEncoderAsset(assetDir, manifest, plat());
      }

      if (!verify.ok) {
        // A failed -> B, unless B init itself fails (allocator) -> C.
        if (host.allocatorFails()) {
          return demote(ENC_FAIL.ASSET_UNREADABLE, "C");
        }
        return demote(verify.code, "B");
      }

      // Allocate only after verification (task 3). Simulate allocator failure.
      if (host.allocatorFails()) {
        return demote(ENC_FAIL.ASSET_UNREADABLE, "B");
      }

      // Cap measured RSS at 150 MiB (task 3).
      const rss = host.rssBytes();
      if (rss > ENCODER_RSS_BUDGET_BYTES) {
        return demote(ENC_FAIL.RSS_BUDGET_EXCEEDED, "B");
      }

      embeddedBytes = verify.embeddedBytes;
      verified = true;
      mode = "A";
      reporter.assetVerified({
        mode: "A",
        embeddedBytes: verify.embeddedBytes,
        onnxDigest: verify.onnxDigest.slice(0, 12),
      });
      return {
        ok: true,
        mode: "A",
        embeddedBytes: verify.embeddedBytes,
        rssBytes: rss,
        sessionId: `enc-${seedFromBytes(verify.embeddedBytes).toString(16)}`,
      };
    },
    infer(input: EncoderInput): EncoderInferResult {
      if (!verified || mode !== "A") {
        // Only batch1/max512 verified assets reach inference (mode B/C do not).
        return {
          ok: false,
          code: ENC_FAIL.SHAPE_INVALID,
          shapeError: "no verified learned asset; mode is " + modeLabel(mode),
        };
      }
      if (!input || !Array.isArray(input.tokens)) {
        return { ok: false, code: ENC_FAIL.SHAPE_INVALID, shapeError: "missing tokens array" };
      }
      const n = input.tokens.length;
      if (n < 1 || n > ENCODER_MAX_TOKENS) {
        return {
          ok: false,
          code: ENC_FAIL.SHAPE_INVALID,
          shapeError: `token count ${n} outside 1..${ENCODER_MAX_TOKENS}`,
        };
      }
      const start = host.nowMs();
      // Batch is always 1 (single request); shape is (1, n) for n in 1..512.
      const semantic = projectSemantic(seedFromBytes(embeddedBytes) ^ n, ENCODER_SEMANTIC_WIDTH);
      const latencyMs = host.nowMs() - start;
      const rssBytes = host.rssBytes();
      if (rssBytes > ENCODER_RSS_BUDGET_BYTES) {
        return {
          ok: false,
          code: ENC_FAIL.RSS_BUDGET_EXCEEDED,
          shapeError: "RSS over budget during inference",
        };
      }
      return { ok: true, semantic, rssBytes, latencyMs, shapeError: null };
    },
  };
  return runtime;
}
