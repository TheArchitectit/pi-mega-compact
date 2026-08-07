/**
 * vector-cortex/encoder/runtime-select.ts — ML5-C decision-rule dispatch.
 *
 * Pure function of {platform, benchRecord, nativeOptIn} → the chosen ONNX
 * runtime backend. This is the deterministic selection that closes HG-3
 * (install budget) and HG-4 (darwin-x64 disposition) per the ML5-C spec:
 *
 *   - Measured p95 at 512 tokens on 4 threads (linux-x64) <= 40 ms  →  Option W (WASM)
 *   - Measured p95 > 40 ms or absent (degraded)                        →  Option N (native)
 *   - Platform is darwin-x64 (Intel Mac, HG-1 deferral)               →  WASM demotion or mode B
 *
 * The `platform` comes from `detectPlatform()` (already in `asset.ts`); the
 * `benchRecord` is the latest `BenchResultV1` (from ML5-B / JSONL); the
 * `nativeOptIn` helper reads `MEGACOMPACT_ENCODER_NATIVE=1`. The selection is
 * PURE — no side effects, no I/O, no network. The caller stamps the result on
 * the `vector_cortex_runtime_selected` event carried to the dashboard.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 — selection is computed+in memory;
 * no fetch/HTTP). No `any` (PREVENT-011).
 */

import {
  ENCODER_LATENCY_P95_MS,
  type EncoderPlatform,
} from "./types.js";
import type { BenchResultV1 } from "./bench-export.js";
import { ML5C_ENABLED, ENC_0E_ENABLED } from "../../config/vector-cortex.js";
import type { EncoderPlatformRow } from "./decision.js";
import {
  DARWIN_X64_DEMOTION_REASON,
  DARWIN_X64_DEMOTION_REASON_SENTINEL,
} from "./decision.js";

/** The chosen runtime backend name as it appears on the seller event. */
export type RuntimeBackendChoice = "wasm" | "native" | "modeB";

/** Inputs to the backend selection. `platform` is `${process.platform}-${process.arch}`. */
export interface RuntimeSelectionInput {
  /** The platform this process is running on (from detectPlatform()). */
  readonly platform: EncoderPlatform | "unsupported";
  /**
   * The ML5-B bench record for this platform (linux-x64 normative). Null when
   * no bench has run yet (degraded: the 42-byte placeholder has no real p95).
   * Must provide a numeric p95Ms for WASM consideration; a null/error record
   * (gates.all:false) forces the native fallback per the decision rule.
   */
  readonly benchRecord: BenchResultV1 | null;
  /** True when the operator opted into onnxruntime-node via MEGACOMPACT_ENCODER_NATIVE=1. */
  readonly nativeOptIn: boolean;
}

/** The output of the ML5-C decision-rule dispatch. */
export interface RuntimeSelectionResult {
  /** The chosen backend. */
  readonly backend: RuntimeBackendChoice;
  /** HG-3 closure state: whether the 80 MiB install budget is satisfied. */
  readonly budgetOk: boolean;
  /** The measured p95 (ms) that drove the decision, from BenchResultV1. */
  readonly p95Ms: number | null;
  /** The platform the selection is valid for. */
  readonly platform: string;
  /** Short human-readable rationale for the choice (record on the event). */
  readonly rationale: string;
  /**
   * ENC-0e explicit demotion reason (non-null ONLY on a demoted platform under
   * `MEGACOMPACT_ENC_0E`). Null on every other platform and on flag-off, so the
   * flag-off selection is byte-identical to the ENC-0d predecessor.
   */
  readonly demotionReason: string | null;
}

/** The 80 MiB install budget in bytes (the HG-3 ceiling, unamended). */
export const RUNTIME_NATIVE_INSTALL_BUDGET_MIB = 80;

/**
 * Per-platform optionalDependency footprint of onnxruntime-node (MiB, approx).
 * These sum to ~160 MiB SHIPPED in the npm package (every target platform is
 * included so the resolver lands on a concrete row at install time) — which is
 * what exceeds the 80 MiB HG-3 budget and forces the amendment the fixtures
 * record (ML5-RUNTIME-001). The per-host INSTALLED footprint (one row only)
 * is 28–35 MiB and irrelevant to the 80 MiB ceiling — the budget covers the
 * shipped tarball, not the single-platform install.
 */
export const NATIVE_FOOTPRINT_MIB: Readonly<Record<EncoderPlatform, number>> = {
  "linux-x64": 33,
  "darwin-arm64": 28,
  "darwin-x64": 33,
  "linux-arm64": 31,
  "win32-x64": 35,
};

/**
 * ML5-C decision-rule dispatch: choose the ONNX runtime backend (pure).
 *
 * When the flag is OFF (`MEGACOMPACT_ML5_C=0`), returns mode B trigram — byte-
 * identical to the ML5-B survivor with no selection event emitted.
 *
 * The rule (from the sprint spec):
 *   - If nativeOptIn && platform is supported → native (Option N)
 *   - If benchRecord has p95Ms <= 40 ms on linux-x64 → WASM (Option W)
 *   - Else → native (Option N) with the budget amendment recorded (p95 exceeds
 *     the WASM gate or is absent — the placeholder has no measured p95)
 *   - darwin-x64 → WASM or mode B demotion per HG-4 (never native here)
 */
export function selectRuntimeBackend(input: RuntimeSelectionInput): RuntimeSelectionResult {
  if (!ML5C_ENABLED()) {
    return {
      backend: "modeB",
      budgetOk: true,
      p95Ms: null,
      platform: input.platform,
      rationale: "flag-off: byte-identical mode-B trigram (no selection)",
      demotionReason: null,
    };
  }

  // HG-4: Intel Mac (darwin-x64) is out-of-scope per HG-1's deferral — always demote.
  if (input.platform === "darwin-x64") {
    return {
      backend: "wasm",
      budgetOk: true,
      p95Ms: null,
      platform: input.platform,
      rationale: "darwin-x64 demoted to WASM per HG-4 (never native on this platform)",
      // ENC-0e: the reason is the single canonical string from the ENC-0a
      // platform matrix (decision.ts). Under flag-off the reason is stripped
      // (null), keeping the flag-off selection byte-identical to the ENC-0d
      // predecessor. If the matrix row ever lacks the reason, fall back to a
      // deterministic sentinel — never throw, never fabricate a native claim.
      demotionReason: ENC_0E_ENABLED() ? darwinX64DemotionReason(undefined) : null,
    };
  }

  // Native opt-in short-circuits: operator explicitly wants the native path.
  // The HG-3 budget compares the SHIPPED byte-count (sum across every platform
  // row in the package's optionalDependencies map) against the 80 MiB ceiling
  // — not the single-platform install size. Native always exceeds 80 MiB across
  // 5 platforms (~160 MiB shipped), so budgetOk is false and the evidence
  // records the amended budget (the ML5-C spec, HG-3 closure).
  if (input.nativeOptIn) {
    const shippedMib = Object.values(NATIVE_FOOTPRINT_MIB).reduce((a, b) => a + b, 0);
    return {
      backend: "native",
      budgetOk: shippedMib <= RUNTIME_NATIVE_INSTALL_BUDGET_MIB,
      p95Ms: input.benchRecord?.p95Ms ?? null,
      platform: input.platform,
      rationale: `native opt-in (MEGACOMPACT_ENCODER_NATIVE=1); shipped ${shippedMib} MiB across 5 platforms → budget amended to ${shippedMib} MiB`,
      demotionReason: null,
    };
  }

  // No bench record or degraded (gates.all:false) → WASM cannot qualify (the
  // placeholder 42-byte asset has no measured real p95), so native is selected
  // with the SAME amended-budget disposition as the opt-in path above: the
  // evidence records the closed HG-3 amendment.
  if (!input.benchRecord || !input.benchRecord.gates.all || input.benchRecord.p95Ms === null) {
    const shippedMib = Object.values(NATIVE_FOOTPRINT_MIB).reduce((a, b) => a + b, 0);
    return {
      backend: "native",
      budgetOk: false, // amended: native ships > 80 MiB across the 5-platform matrix
      p95Ms: input.benchRecord?.p95Ms ?? null,
      platform: input.platform,
      rationale: `no qualifying bench record — native fallback with budget amendment (${shippedMib} MiB shipped, HG-3 amendment recorded)`,
      demotionReason: null,
    };
  }

  // The decision rule: WASM iff p95 <= 40 ms (linux-x64, 512 tokens, 4 threads) —
  // native required otherwise, with the same budget amendment recorded.
  if (input.benchRecord.p95Ms <= ENCODER_LATENCY_P95_MS) {
    return {
      backend: "wasm",
      budgetOk: true,
      p95Ms: input.benchRecord.p95Ms,
      platform: input.platform,
      rationale: `WASM qualifies: p95 ${input.benchRecord.p95Ms}ms <= ${ENCODER_LATENCY_P95_MS}ms`,
      demotionReason: null,
    };
  }

  return {
    backend: "native",
    budgetOk: false, // amended: native exceeds the 80 MiB budget per the evidence
    p95Ms: input.benchRecord.p95Ms,
    platform: input.platform,
    rationale: `native required: p95 ${input.benchRecord.p95Ms}ms > ${ENCODER_LATENCY_P95_MS}ms on WASM`,
    demotionReason: null,
  };
}

/**
 * ENC-0e — resolve the canonical darwin-x64 demotion reason (pure).
 *
 * `provider` is the ENC-0a platform-matrix row for darwin-x64 if the caller has
 * one (the resolver owns a concrete matrix; runtime-select normally passes
 * none and falls back to the canonical constant). Resolution order:
 *   1. the provider row's `demotionReason` (single canonical source);
 *   2. the canonical DARWIN_X64_DEMOTION_REASON constant;
 *   3. the deterministic SENTINEL when a row EXISTS but lacks the reason
 *      (unique-failure injection per ENC-0e) — never a throw, never a
 *      fabricated native claim.
 * Kept pure so tests inject the platform seam with no real Mac.
 */
export function darwinX64DemotionReason(provider: EncoderPlatformRow | undefined): string {
  if (provider) {
    if (provider.demotionReason && provider.demotionReason.length > 0) {
      return provider.demotionReason;
    }
    return DARWIN_X64_DEMOTION_REASON_SENTINEL;
  }
  return DARWIN_X64_DEMOTION_REASON;
}
