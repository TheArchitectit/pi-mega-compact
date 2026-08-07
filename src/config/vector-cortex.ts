/**
 * config/vector-cortex.ts — vector-cortex feature flags + breaker/triad constants.
 *
 * Every sprint ships one positive `MEGACOMPACT_<SPRINT>` flag, default ON and
 * `=0`/`_DISABLED` off. Flag-OFF is byte-identical to the predecessor sprint's
 * behavior (for VC0A: mode C — observer absent, zero evaluation writes).
 *
 * Breaker/triad constants (TRIAD_RESILIENCE.md) live here; pi-agnostic, dep-free.
 */
// VC0/VC1/VC2 foundation-phase flags in vector-cortex-early.ts; re-exported
// so every existing `from "./config/vector-cortex.js"` import resolves unchanged.
export {
  VC0A_ENABLED,
  VC0B_ENABLED,
  VC0C_ENABLED,
  VC1A_ENABLED,
  VC1B_ENABLED,
  VC1C_ENABLED,
  VC2A_ENABLED,
  VC2B_ENABLED,
  VC2C_ENABLED,
} from "./vector-cortex-early.js";

// VC3A..VC8B flags extracted to vector-cortex-vc3to8.ts (mechanical move so
// this barrel stays under the 300-line soft cap); re-exported unchanged.
export {
  VC3A_ENABLED,
  VC3B_ENABLED,
  VC3C_ENABLED,
  VC4A_ENABLED,
  VC4B_ENABLED,
  VC4C_ENABLED,
  VC5A_ENABLED,
  VC5B_ENABLED,
  VC5C_ENABLED,
  VC6A_ENABLED,
  VC6B_ENABLED,
  VC6C_ENABLED,
  VC7A_ENABLED,
  VC7B_ENABLED,
  VC7C_ENABLED,
  VC8A_ENABLED,
  VC8B_ENABLED,
} from "./vector-cortex-vc3to8.js";

export { VC8C_ENABLED } from "./vector-cortex-vc8c.js";
export { VC9A_ENABLED } from "./vector-cortex-vc9a.js";
export { VC9B_ENABLED } from "./vector-cortex-vc9b.js";
export { VC9C_ENABLED } from "./vector-cortex-vc9c.js";
export { VC9D_ENABLED } from "./vector-cortex-vc9d.js";
export { PCC_ENABLED } from "./vector-cortex-pcc.js";
export { ML5A_ENABLED } from "./vector-cortex-ml5a.js";
export { ML5B_ENABLED } from "./vector-cortex-ml5b.js";
export { ML5C_ENABLED } from "./vector-cortex-ml5c.js";
export { ML5D_ENABLED } from "./vector-cortex-ml5d.js";
export { ML5E_ENABLED } from "./vector-cortex-ml5e.js";
export { DEDUP_ATTR_ENABLED } from "./vector-cortex-dedup-attr.js";
export { ENC_0A_ENABLED } from "./vector-cortex-enc0a.js";
export { ENC_0B_ENABLED } from "./vector-cortex-enc0b.js";
export { ENC_0C_ENABLED } from "./vector-cortex-enc0c.js";
export { ENC_0D_ENABLED } from "./vector-cortex-enc0d.js";
export { ENC_0E_ENABLED } from "./vector-cortex-enc0e.js";
export { ENC_0F_ENABLED } from "./vector-cortex-enc0f.js";
export { ENC_0G_ENABLED } from "./vector-cortex-enc0g.js";
// COS-FP-A synthetic FP harness flag extracted to vector-cortex-cosfp.ts.
export { COSINE_FP_BENCH_ENABLED } from "./vector-cortex-cosfp.js";
export { ENC_1A_ENABLED } from "./vector-cortex-enc1a.js";
export {
  ENC_1B_ENABLED,
  ENC_1B_MAX_EMBEDDING_DIM,
  ENC_1B_EMBEDDING_DIM_ENV,
  ENC_1B_EMBEDDING_HEADERS_ENV,
  ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV,
  ENC_1B_ENCODER_NATIVE_ENV,
} from "./vector-cortex-enc1b.js";
export {
  ENC_2BUDGET_ENABLED,
  ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV,
  ENC_2BUDGET_MAX_MIB,
  ENC_2BUDGET_DEFAULT_MIB,
} from "./vector-cortex-enc2budget.js";
// Breaker constants (TRIAD_RESILIENCE.md §breaker) extracted to vector-cortex-breakers.ts.
export {
  BREAKER_WINDOW_MS,
  BREAKER_MIN_ATTEMPTS,
  BREAKER_PERF_FAILURES,
  BREAKER_PERF_FAILURE_RATE,
  BREAKER_CORRECTNESS_FAILURES,
  BREAKER_COOLDOWN_MS,
  BREAKER_PROBE_COUNT,
  BREAKER_RETRY_BASE_MS,
  BREAKER_RETRY_CAP_MS,
  BREAKER_RETRY_JITTER,
  BREAKER_HYSTERESIS_FAILURE_RATE,
  BREAKER_HYSTERESIS_BUDGET_P95_MS,
  BREAKER_MIN_HEALTHY_RESIDENCE_MS,
} from "./vector-cortex-breakers.js";
