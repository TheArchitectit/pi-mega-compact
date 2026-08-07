/**
 * config/vector-cortex-cosfp.ts — COS-FP-A synthetic FP harness sprint flag.
 *
 * Extracted from vector-cortex.ts so that barrel stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc9a.ts and the other
 * per-sprint flag siblings were. Gating the synthetic cosine false-positive
 * harness: the corpus/bench scripts, the derived report, and the reader-only
 * GET /api/cosine-fp-report endpoint. A pure-local, synthetic-corpus-only tool
 * (EVAL-REDACT-002) — it never reads real session/ledger bytes.
 *
 * The split is mechanical: COSINE_FP_BENCH_ENABLED is byte-identical in name,
 * semantics, and default to the sibling flag convention (positive, default ON),
 * and vector-cortex.ts re-exports it so every existing
 * `from "./config/vector-cortex.js"` import keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * COS-FP-A — synthetic FP harness + L2 cosine threshold calibration.
 * Default ON. `MEGACOMPACT_COSINE_FP_BENCH=0` disables and is byte-identical to
 * the predecessor: `scripts/cosine-fp/bench.mjs` is inert (gates report
 * emission + the endpoint to 404/absent), no report is (re)written, and
 * `L2_COSINE` continues to be plain `MEGACOMPACT_L2_THRESHOLD`. The two
 * content-type override fields added to config/dedup.ts are null when unset and
 * are NOT wired into the live L2 decision this sprint (a declared landing slot
 * for the report's per-content-type recommendation). This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS).
 * The harness + endpoint perform only local filesystem reads (PREVENT-PI-004).
 */
export const COSINE_FP_BENCH_ENABLED = (): boolean =>
  sprintFlag("MEGACOMPACT_COSINE_FP_BENCH");
