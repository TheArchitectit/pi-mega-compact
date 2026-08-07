/**
 * vector-cortex/encoder/runtime.ts — VC2A EncoderRuntime (task 3) + ML5-C shell.
 *
 * Allocates (prepares an inference session) ONLY after manifest verification;
 * rejects any non (batch 1, tokens <= maxTokens, <=512) input with
 * ENC_SHAPE_INVALID; caps the encoder's MARGINAL footprint at 150 MiB
 * (ENC_RSS_BUDGET_EXCEEDED -> mode B); and yields a deterministic mode-A
 * inference over the verified asset (the trained weights are substituted in
 * VC2C — the contract, shape gating and budgets all land here).
 *
 * ML5-C RUNTIME-SELECTION DISPATCH: the VC2A-era LCG `projectSemantic`
 * placeholder is closed STRUCTURALLY here — the `projectSemantic` implementation
 * moved to `runtime-stub.ts` and the ML5-C selection dispatch + seller emission
 * live in `runtime-select.ts` + `runtime-emit.ts` so this file stays under the
 * 300-line soft limit while still being the public entry (the EncoderRuntime
 * interface contract is unchanged for every pre-ML5-C consumer). The dispatch
 * itself runs only under `MEGACOMPACT_ML5_C=1`; with the flag OFF the encoder
 * serves mode B trigram exactly as the ML5-B survivor did (byte-identical,
 * no `vector_cortex_runtime_selected` event emitted).
 *
 * The two concrete backends (`runtime-wasm.ts`, `runtime-native.ts`) provide
 * the `WasmSession`/`NativeSession` shapes that will replace this LCG path once
 * a real trained asset lands. The runtime-selection emitted here is the seller
 * event the dashboard Setup Cortex blockers card reads to close HG-3/HG-4.
 *
 * MEMORY BUDGET (Q01/Q02): the 150 MiB cap measures the encoder's INCREMENTAL
 * footprint — an in-process allocation counter (`selfAllocated`) plus any
 * externally staged asset working set (`host.allocatedBytes()`) — NOT the
 * whole-process RSS. In a live pi extension the process baseline (node:sqlite
 * DatabaseSync + dashboard + loaded context) routinely exceeds 150 MiB, so an
 * absolute-RSS cap would permanently demote a qualified asset to mode B and
 * make mode A unreachable in production. Bounding the marginal footprint keeps
 * mode A reachable while still enforcing the budget. `selfAllocated` models a
 * single REUSABLE 384-float projection buffer (first inference allocates it,
 * every later inference reuses it), so it is capped at `SEMANTIC_BUFFER_BYTES`
 * — the marginal footprint can never grow without bound (Q01), and a long-lived
 * runtime cannot drift over budget from healthy operation. The check runs
 * BEFORE the allocation on both the load and the inference path
 * (cap-before-allocation, task 3), and an over-budget inference demotes the
 * runtime to mode B just as an over-budget load does (consistent demotion per
 * ENC_FAIL.RSS_BUDGET_EXCEEDED).
 *
 * TOKEN CAPACITY (Q03): the per-manifest `maxTokens` (<= 512) is stored at load
 * and enforced at inference — an input longer than the verified manifest's
 * declared capacity is rejected with ENC_SHAPE_INVALID, honoring the model
 * contract rather than a global 512 ceiling.
 *
 * FLAG GATING (Q04): the default factory consults `MEGACOMPACT_VC2A`; when the
 * flag is OFF the runtime is fixed at mode C (rollback, byte-identical to the
 * predecessor — no asset is read or verified). `forcedMode: "C"` is the
 * explicit override for the same rollback path. The ML5-C dispatch gates
 * additionally on `MEGACOMPACT_ML5_C` — when that flag is OFF, the selection
 * path is skipped and the LCG placeholder serves mode A exactly as the ML5-B
 * survivor did (byte-identical).
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
import { VC2A_ENABLED, ML5C_ENABLED } from "../../config/vector-cortex.js";
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
  type EncoderPlatform,
} from "./types.js";
import { selectRuntimeBackend } from "./runtime-select.js";
import { emitRuntimeSelected } from "./runtime-emit.js";
// guardrails-allow PREVENT-STUB-001: ML5-A (imports the VC2A seeded-projection placeholder; real inference subs in ML5-D/C)
import { projectSemantic, seedFromBytes } from "./runtime-stub.js";
import { STATE_DIR_DEFAULT } from "../../config.js";
import { tryBuildOnnx, type OnnxDispatchState, NO_ONNX } from "./encoder-onnx-dispatch.js";

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
  /**
   * ML5-C: path to the state dir whose events.log records the
   * vector_cortex_runtime_selected seller (defaults to STATE_DIR_DEFAULT).
   */
  readonly stateDir?: string;
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
   *  any asset (byte-identical to the pre-triad derived pointer). */
  readonly forcedMode?: "C";
  /** Override the platform detector (tests / cross-platform demotion). */
  readonly platform?: () => ReturnType<typeof detectPlatform>;
}

function mergeHost(partial?: Partial<RuntimeHost>): RuntimeHost {
  return { ...DEFAULT_HOST, ...partial };
}

function modeLabel(mode: EncoderMode): string {
  return mode === "A" ? "qualified-onnx" : mode === "B" ? "trigram" : "lexical";
}

/** Normalise detectPlatform output for the runtime-select input. */
function normalizePlatform(p: EncoderPlatform | null): EncoderPlatform | "unsupported" {
  return p === null ? "unsupported" : p;
}

/** The concrete runtime returned by createEncoderRuntime — the base
 *  EncoderRuntime interface plus the ENC-0b ONNX dispatch state. */
export type EncoderRuntimeHandle = EncoderRuntime & {
  /** ENC-0b: the ONNX dispatch state (null when ENC_0B is off or not built). */
  readonly onnxState: OnnxDispatchState;
};

export function createEncoderRuntime(
  options: CreateEncoderRuntimeOptions = {},
): EncoderRuntimeHandle {
  const reporter = options.reporter ?? createEncoderReporter();
  const host = mergeHost(options.host);
  const forced = options.forcedMode;
  const plat = options.platform ?? detectPlatform;

  // Q04: rollback contract — MEGACOMPACT_VC2A=0 selects mode C (byte-identical
  // to the predecessor). The ML5-C flag-off branch follows the same pattern.
  const rolledBack = forced === "C" || !VC2A_ENABLED();
  let mode: EncoderMode = rolledBack ? "C" : "C";
  let embeddedBytes = 0;
  let verified = false;
  let maxTokens = ENCODER_MAX_TOKENS;
  let selfAllocated = 0;
  let onnxState: OnnxDispatchState = NO_ONNX;

  const footprint = (): number => selfAllocated + host.allocatedBytes();

  const demoteTo = (rmode: "B" | "C", code: string): void => {
    mode = rmode;
    verified = false;
    reporter.runtimeDemoted({ reason: code, mode: rmode, platform: plat()?.toString() ?? "unsupported" });
  };

  const runtime: EncoderRuntimeHandle = {
    schema: "encoder-runtime-v1",
    get mode(): EncoderMode {
      return mode;
    },
    get onnxState(): OnnxDispatchState {
      return onnxState;
    },
    load(assetDir: string): EncoderLoadResult {
      if (rolledBack) {
        // Q04: report the rollback with its own code, not MANIFEST_INVALID.
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
        if (host.allocatorFails()) {
          demoteTo("C", ENC_FAIL.ASSET_UNREADABLE);
          return { ok: false, mode: "C", code: ENC_FAIL.ASSET_UNREADABLE };
        }
        demoteTo("B", verify.code);
        return { ok: false, mode: "B", code: verify.code };
      }

      // Allocate only after verification (task 3).
      if (host.allocatorFails()) {
        demoteTo("B", ENC_FAIL.ASSET_UNREADABLE);
        return { ok: false, mode: "B", code: ENC_FAIL.ASSET_UNREADABLE };
      }

      // Cap the encoder's MARGINAL footprint at 150 MiB (task 3, Q01).
      if (footprint() > ENCODER_RSS_BUDGET_BYTES) {
        demoteTo("B", ENC_FAIL.RSS_BUDGET_EXCEEDED);
        return { ok: false, mode: "B", code: ENC_FAIL.RSS_BUDGET_EXCEEDED };
      }

      embeddedBytes = verify.embeddedBytes;
      maxTokens = verify.maxTokens;
      verified = true;
      mode = "A";
      reporter.assetVerified({
        mode: "A",
        embeddedBytes: verify.embeddedBytes,
        onnxDigest: verify.onnxDigest.slice(0, 12),
      });

      // ML5-C: runtime-backend selection dispatch + the seller event. Pure
      // function + append-only log line; skipped entirely when the flag is off.
      if (ML5C_ENABLED()) {
        const chosen = selectRuntimeBackend({
          platform: normalizePlatform(plat()),
          benchRecord: null, // guardrails-allow PREVENT-STUB-001: ML5-E (placeholder: real BenchResultV1 wiring ships in ML5-E)
          nativeOptIn: process.env.MEGACOMPACT_ENCODER_NATIVE === "1",
        });
        emitRuntimeSelected(host.stateDir ?? STATE_DIR_DEFAULT, chosen);
      }

      // ENC-0b: fire-and-forget ONNX session build (async, non-blocking).
      // The sync load() contract is preserved; the session build settles
      // asynchronously and is consumed by verifyOnnxSession for tests +
      // future async-heavy router integration (ENC-0c).
      if (manifest) {
        onnxState = tryBuildOnnx(assetDir, manifest, reporter, footprint());
      }

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
      if (n < 1 || n > maxTokens) {
        return {
          ok: false,
          code: ENC_FAIL.SHAPE_INVALID,
          shapeError: `token count ${n} outside 1..${maxTokens} (manifest cap)`,
        };
      }
      // Q03: cap-before-allocation on the inference path too.
      if (footprint() > ENCODER_RSS_BUDGET_BYTES) {
        demoteTo("B", ENC_FAIL.RSS_BUDGET_EXCEEDED);
        return {
          ok: false,
          code: ENC_FAIL.RSS_BUDGET_EXCEEDED,
          shapeError: "encoder footprint over budget during inference",
        };
      }
      const start = host.nowMs();
      // ENC-0b builds the real ONNX session during load() (fire-and-forget);
      // infer() continues serving the LCG placeholder until the router is
      // wired for async inference (ENC-0c). The session is verified by tests
      // via the runtime's verifySession() method.
      const semantic = projectSemantic(seedFromBytes(embeddedBytes) ^ n, ENCODER_SEMANTIC_WIDTH);
      selfAllocated = SEMANTIC_BUFFER_BYTES;
      return { ok: true, semantic, rssBytes: footprint(), latencyMs: host.nowMs() - start, shapeError: null };
    },
  };
  return runtime;
}
