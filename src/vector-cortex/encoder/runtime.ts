/**
 * vector-cortex/encoder/runtime.ts — VC2A EncoderRuntime (task 3).
 *
 * Allocates (prepares an inference session) ONLY after manifest verification;
 * rejects any non (batch 1, tokens <= maxTokens, <=512) input with
 * ENC_SHAPE_INVALID; caps the encoder's MARGINAL footprint at 150 MiB
 * (ENC_RSS_BUDGET_EXCEEDED -> mode B); and yields a deterministic mode-A
 * inference over the verified asset (the trained weights are substituted in
 * VC2C — the contract, shape gating and budgets all land here).
 *
 * MEMORY BUDGET (Q01/Q03): the 150 MiB cap measures the encoder's INCREMENTAL
 * footprint — an in-process allocation counter (`selfAllocated`) plus any
 * externally staged asset working set (`host.allocatedBytes()`) — NOT the
 * whole-process RSS. In a live pi extension the process baseline (node:sqlite
 * DatabaseSync + dashboard + loaded context) routinely exceeds 150 MiB, so an
 * absolute-RSS cap would permanently demote a qualified asset to mode B and
 * make mode A unreachable in production. Bounding the marginal footprint keeps
 * mode A reachable while still enforcing the budget. The check runs BEFORE the
 * allocation on both the load and the inference path (cap-before-allocation,
 * task 3), and an over-budget inference demotes the runtime to mode B just as
 * an over-budget load does (consistent demotion per ENC_FAIL.RSS_BUDGET_EXCEEDED).
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

/** Bytes a single encoder-owned projection buffer commits to the marginal
 *  footprint (Float32Array, 4 bytes per element). */
const SEMANTIC_BUFFER_BYTES = ENCODER_SEMANTIC_WIDTH * 4;

/** Injectable seam for allocation accounting + allocator + clock so tests can
 *  drive failures deterministically. Allocation accounting is the encoder's
 *  MARGINAL footprint (Q01) — NOT whole-process RSS. */
export interface RuntimeHost {
  /** External bytes already committed to the encoder's incremental working set
   *  (e.g. an ONNX session buffer staged outside this runtime). Default 0. */
  readonly allocatedBytes: () => number;
  readonly allocatorFails: () => boolean;
  readonly nowMs: () => number;
}

const DEFAULT_HOST: RuntimeHost = {
  allocatedBytes: () => 0,
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
  /** Bytes this runtime itself has allocated (projection buffers). This is the
   *  encoder's incremental footprint — combined with `host.allocatedBytes()`
   *  it drives the 150 MiB marginal budget (Q01), never whole-process RSS. */
  let selfAllocated = 0;

  /** The encoder's marginal working-set footprint, in bytes. */
  const footprint = (): number => selfAllocated + host.allocatedBytes();

  const demoteTo = (rmode: "B" | "C", code: string): void => {
    mode = rmode;
    verified = false;
    reporter.runtimeDemoted({ reason: code, mode: rmode, platform: plat()?.toString() ?? "unsupported" });
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
        // Q04: report the rollback with its own code, not MANIFEST_INVALID, so a
        // correctly-shaped, digest-correct asset is not mis-read as corrupted.
        mode = "C";
        verified = false;
        return { ok: false, mode: "C", code: ENC_FAIL.ROLLBACK };
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
          demoteTo("C", ENC_FAIL.ASSET_UNREADABLE);
          return { ok: false, mode: "C", code: ENC_FAIL.ASSET_UNREADABLE };
        }
        demoteTo("B", verify.code);
        return { ok: false, mode: "B", code: verify.code };
      }

      // Allocate only after verification (task 3). Simulate allocator failure.
      if (host.allocatorFails()) {
        demoteTo("B", ENC_FAIL.ASSET_UNREADABLE);
        return { ok: false, mode: "B", code: ENC_FAIL.ASSET_UNREADABLE };
      }

      // Cap the encoder's MARGINAL footprint at 150 MiB (task 3, Q01). This
      // bounds the encoder's incremental allocation, so a healthy process with
      // a large baseline RSS still reaches mode A.
      if (footprint() > ENCODER_RSS_BUDGET_BYTES) {
        demoteTo("B", ENC_FAIL.RSS_BUDGET_EXCEEDED);
        return { ok: false, mode: "B", code: ENC_FAIL.RSS_BUDGET_EXCEEDED };
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
        rssBytes: footprint(),
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
      // Q03: cap-before-allocation on the inference path too. Check the
      // marginal footprint BEFORE allocating the projection buffer; an
      // over-budget inference demotes to mode B consistently with load() (the
      // ENC_FAIL.RSS_BUDGET_EXCEEDED model: "measured RSS over 150 MiB -> B"),
      // so a subsequent infer no longer attempts allocation in a stale mode A.
      if (footprint() > ENCODER_RSS_BUDGET_BYTES) {
        demoteTo("B", ENC_FAIL.RSS_BUDGET_EXCEEDED);
        return {
          ok: false,
          code: ENC_FAIL.RSS_BUDGET_EXCEEDED,
          shapeError: "encoder footprint over budget during inference",
        };
      }
      const start = host.nowMs();
      // Batch is always 1 (single request); shape is (1, n) for n in 1..512.
      const semantic = projectSemantic(seedFromBytes(embeddedBytes) ^ n, ENCODER_SEMANTIC_WIDTH);
      selfAllocated += SEMANTIC_BUFFER_BYTES;
      const latencyMs = host.nowMs() - start;
      return { ok: true, semantic, rssBytes: footprint(), latencyMs, shapeError: null };
    },
  };
  return runtime;
}
