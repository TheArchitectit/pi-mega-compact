/**
 * config/vector-cortex-cosfp-real.ts — COS-FP-R real-corpus FP validation flag.
 *
 * Extracted from vector-cortex.ts so that barrel stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-cosfp.ts and the other
 * per-sprint flag siblings were. Gating the real-corpus L2 cosine false-positive
 * validation: the `scripts/cosine-fp/real-bench.mjs` execution harness that runs
 * only when a consented donated corpus exists, the execution-time report rows,
 * and the evidence record. A pure-local, consent-gated tool (SECURITY_PRIVACY
 * §Lifecycle/§Consent + EVAL-REDACT-002) — it never reads real session/ledger
 * bytes without an explicit per-session consent record.
 *
 * The split is mechanical: COSINE_FP_REAL_ENABLED is byte-identical in name,
 * semantics, and default to the sibling flag convention (positive, default ON),
 * and vector-cortex.ts re-exports it so every existing
 * `from "./config/vector-cortex.js"` import keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * COS-FP-R — real-corpus L2 cosine FP validation against donated sessions.
 * Default ON. `MEGACOMPACT_COSINE_FP_REAL=0` disables and is byte-identical to
 * the predecessor: `scripts/cosine-fp/real-bench.mjs` is inert (nothing
 * executes, no writes), no real-corpus report rows or evidence are written, and
 * no threshold is adopted. When ON (default), execution still only proceeds when
 * a valid consented corpus exists under `scripts/cosine-fp/corpus/` — absent
 * corpus is the normative `no_corpus` pre-donation state, not a failure. Corpus
 * bytes are read only for sessions with an explicit, append-only, revocable
 * consent record (SECURITY_PRIVACY §Lifecycle/§Consent). This flag MUST also be
 * a dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS).
 * The harness performs only local filesystem reads (PREVENT-PI-004).
 */
export const COSINE_FP_REAL_ENABLED = (): boolean =>
  sprintFlag("MEGACOMPACT_COSINE_FP_REAL");
