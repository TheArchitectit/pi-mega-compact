/**
 * config/vector-cortex.ts — vector-cortex feature flags + breaker/triad constants.
 *
 * Every sprint ships one positive `MEGACOMPACT_<SPRINT>` flag, default ON and
 * `=0`/`_DISABLED` off. Flag-OFF is byte-identical to the predecessor sprint's
 * behavior (for VC0A: mode C — observer absent, zero evaluation writes).
 *
 * The breaker/triad constants (TRIAD_RESILIENCE.md) live here so VC0C consumes
 * them without re-declaring the ownership boundary. Pi-agnostic, dependency-free.
 */

import { sprintFlag } from "./vector-cortex-flag.js";

// VC0/VC1/VC2 foundation-phase flags extracted to vector-cortex-early.ts to keep
// this file under the 300-line soft limit. Re-exported here so every existing
// `from "./config/vector-cortex.js"` import keeps resolving unchanged.
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

/**
 * VC3A — capability-gated cortex store (CortexReader/Writer/Admin, CortexRecordV1).
 * Default ON. `MEGACOMPACT_VC3A=0` disables and is byte-identical to the
 * predecessor (mode C: the derived cortex store is absent, mode B in-memory is
 * not consulted, zero `vector_cortex_record_append_failed` /
 * `vector_cortex_generation_rebuilt` emissions; the predecessor derived pointer
 * and goldens are unchanged). The real consumers are the cortex append seam, the
 * cortex rebuild/admin seam and the reader-only topology summary seam.
 */
export const VC3A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC3A");

/**
 * VC3B — deterministic cortical topology (TopologyV1 / EdgeV1).
 * Default ON. `MEGACOMPACT_VC3B=0` disables and is byte-identical to the
 * predecessor (mode C: no topology graph is built or emitted, the dashboard
 * topology view returns the VC3A-precise aggregation shape with no node/edge
 * arrays, zero `vector_cortex_topology_*` emissions). The real consumers are
 * the topology build seam (build.ts) and the dashboard topology node/edge view.
 */
export const VC3B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC3B");

/**
 * VC3C — topology query + router invalidation (TopologyQueryV1 / RouterKeyV2,
 * M6 router-generation-v2 migration).
 * Default ON. `MEGACOMPACT_VC3C=0` disables and is byte-identical to the
 * predecessor (mode C: no length-delimited router key, no generation
 * invalidation, zero `vector_cortex_router_generation_invalidated` /
 * `vector_cortex_topology_query_demoted` emissions; the predecessor tiered
 * router keying is unchanged). The real consumers are the topology query seam
 * (query.ts), the M6 router-generation-v2 migration seam, and the reader-only
 * dashboard topology query diagnostic view.
 */
export const VC3C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC3C");

/**
 * VC4A — dual-tier shard contract (SemanticShardV1 / ExactShardV1 /
 * ShardManifestV1).
 * Default ON. `MEGACOMPACT_VC4A=0` disables and is byte-identical to the
 * predecessor (mode C: exact anchors/current transcript only, no semantic or
 * exact shard manifest is assembled or emitted, zero
 * `vector_cortex_shard_manifest_built` / `vector_cortex_protected_span_rejected`
 * emissions; the predecessor derived pointer and goldens are unchanged). The
 * real consumers are the shard assembly seam (manifest.ts) and the reader-only
 * dashboard shards aggregate view.
 */
export const VC4A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC4A");

/**
 * VC4B — residual codec and numeric parity (ResidualCodecV1 / ParityShardV1).
 * Default ON. `MEGACOMPACT_VC4B=0` disables and is byte-identical to the
 * predecessor (mode C: no residual artifact is admitted, the exact compressed
 * payload / ledger bytes remain the only representation, zero
 * `vector_cortex_residual_admitted` / `vector_cortex_parity_recovery_failed`
 * emissions; the VC4A shard manifest and its goldens are unchanged). The real
 * consumers are the codec admission seam (codec.ts) and the reader-only
 * dashboard residual aggregate view. The codec math itself is PURE — flag OFF
 * gates the reporter/admission seam, never the arithmetic.
 */
export const VC4B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC4B");

/**
 * VC4C — reconstruction fidelity (closure + assemble + validate). Default ON.
 * `MEGACOMPACT_VC4C=0` disables and is byte-identical to the predecessor
 * (VC4B): no conservative closure is computed, the reconstruction validator's
 * `vector_cortex_reconstruction_validated` / `vector_cortex_closure_rejected`
 * events are never emitted, and the assembled reconstruction is never produced
 * (the prompt continues to be built by the legacy VC4B exact/residual path and
 * the VC4A shard goldens are unchanged). The closure/assemble/validate
 * functions are PURE — flag OFF gates the reporter seam, never the arithmetic.
 * This flag MUST also be a dashboard SETTINGS toggle (visible in config UI,
 * never in EXCLUDED_SETTINGS), mirroring VC4A/VC4B.
 */
export const VC4C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC4C");

/**
 * VC5A — PromptDagV1 + budgeted portfolio planner. Default ON.
 * `MEGACOMPACT_VC5A=0` disables and is byte-identical to the predecessor
 * (VC4C): no prompt DAG is built or validated, no budgeted plan is selected,
 * the `vector_cortex_plan_selected` / `vector_cortex_plan_mandatory_overflow`
 * events are never emitted, and the prompt continues to be built by the
 * predecessor VC4C closure/reconstruction path (its goldens are unchanged).
 * The builder/validator/portfolio functions are PURE — flag OFF gates the
 * reporter + dashboard seam, never the arithmetic. This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring VC4A/VC4B/VC4C.
 */
export const VC5A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC5A");

/**
 * VC5B — validated prompt renderer + provider profiles. Default ON.
 * `MEGACOMPACT_VC5B=0` disables and is byte-identical to the predecessor
 * (VC5A): no render manifest is produced, no canonical request is hashed, the
 * `vector_cortex_render_validated` / `vector_cortex_provider_bypassed` events are
 * never emitted, and the prompt continues to be built by the predecessor VC5A
 * DAG/plan path (its goldens are unchanged). The render/validate functions are
 * PURE — flag OFF gates the reporter + dashboard seam, never the arithmetic.
 * This flag MUST also be a dashboard SETTINGS toggle (visible in config UI, never
 * in EXCLUDED_SETTINGS), mirroring VC4A/VC4B/VC4C/VC5A.
 */
export const VC5B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC5B");

/**
 * VC5C — live graduated rollout. Default ON. `MEGACOMPACT_VC5C=0` disables and
 * is byte-identical to the predecessor (VC5B): no session is assigned a stable
 * 10k bucket, no gate-advance decision runs, the `vector_cortex_rollout_assigned`
 * / `vector_cortex_rollout_promotion_blocked` events are never emitted, and the
 * prompt continues to be built by the predecessor VC5B renderer path (its goldens
 * are unchanged). The assign/gate/emit functions are PURE — flag OFF gates the
 * reporter + dashboard seam, never the arithmetic. This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring VC4A/VC4B/VC4C/VC5A/VC5B.
 */
export const VC5C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC5C");

/**
 * VC6A — advanced closure optimization. Default ON. `MEGACOMPACT_VC6A=0`
 * disables and is byte-identical to the predecessor (VC5C): the `optimizeClosure`
 * transitive-reduction arithmetic STILL RUNS (it is PURE), but the
 * `vector_cortex_closure_optimized` / `vector_cortex_closure_proof_rejected`
 * events are never emitted and the dashboard closure diagnostics seam is
 * suppressed. Flag OFF gates the reporter + dashboard seam, never the arithmetic,
 * so flag-off outbound/predecessor golden bytes match exactly. This flag MUST
 * also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS), mirroring VC4A/VC4B/VC4C/VC5A/VC5B/VC5C.
 */
export const VC6A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC6A");

/**
 * VC6B — exact source restoration. Default ON. `MEGACOMPACT_VC6B=0` disables and
 * is byte-identical to the predecessor (VC6A): the `restoreSources` /
 * `verifyRestored` arithmetic STILL RUNS (it is PURE — an exact-source read plus
 * a SHA-256 comparison, with no clock, storage, or network), but the
 * `vector_cortex_source_restored` / `vector_cortex_restore_digest_rejected`
 * events are never emitted and the dashboard restoration diagnostics seam is
 * suppressed. Flag OFF gates the reporter + dashboard seam, never the
 * restore/verify arithmetic, so flag-off outbound/predecessor golden bytes match
 * exactly. This flag MUST also be a dashboard SETTINGS toggle (visible in config
 * UI, never in EXCLUDED_SETTINGS), mirroring VC4A/VC4B/VC4C/VC5A/VC5B/VC5C/VC6A.
 */
export const VC6B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC6B");

/**
 * VC6C — self-healing derived controller. Default ON. `MEGACOMPACT_VC6C=0`
 * disables and is byte-identical to the predecessor (VC6B): the `detectGaps` /
 * `planRebuild` / `rebuildGeneration` / `switchPointer` arithmetic STILL RUNS (it
 * is PURE — a high-water comparison plus a SHA-256 root-digest check, with an
 * INJECTED clock and no storage or network), but the
 * `vector_cortex_repair_planned` / `vector_cortex_repair_pointer_switched` /
 * `vector_cortex_repair_backoff` events are never emitted and the dashboard
 * repair diagnostics seam is suppressed. Flag OFF gates the reporter + dashboard
 * seam, never the gap-detection/rebuild arithmetic (in particular, an unverified
 * pointer switch stays refused with the flag off), so flag-off
 * outbound/predecessor golden bytes match exactly. This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring VC4A/VC4B/VC4C/VC5A/VC5B/VC5C/VC6A/VC6B.
 */
export const VC6C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC6C");

/**
 * VC7A — frozen range crystals. Default ON. `MEGACOMPACT_VC7A=0` disables and is
 * byte-identical to the predecessor (VC6C): the `encodeCrystalKey` /
 * `CrystalStore` arithmetic STILL RUNS (it is PURE — a canonical length-prefixed
 * encoding plus SHA-256, with no clock, storage, or network), so a crystal is
 * keyed identically and a same-key/different-bytes write is still refused with
 * the flag off. The flag gates ONLY the `vector_cortex_crystal_written` /
 * `vector_cortex_crystal_collision` events and the cache-crystals dashboard seam,
 * which reports `enabled:false` + mode C when off. Flag OFF never gates the
 * crystal/store arithmetic, so flag-off outbound/predecessor golden bytes match
 * exactly. This flag MUST also be a dashboard SETTINGS toggle (visible in config
 * UI, never in EXCLUDED_SETTINGS), mirroring VC4A..VC6C.
 */
export const VC7A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC7A");

/**
 * VC7B — provider cache economics + crystal compiler. Default ON.
 * `MEGACOMPACT_VC7B=0` disables and is byte-identical to the predecessor
 * (VC7A): `computeEconomics`, `compileCrystalBoundaries` and `assignExperiment`
 * STILL RUN (they are PURE — exact integer/rational arithmetic and a SHA-256
 * session bucket, with no clock, storage, or network), so a session keeps its
 * SAME experiment arm and the compiler keeps producing the SAME boundaries with
 * the flag off. Crucially the compiler never changes request identity in either
 * state, so the outbound canonical request — and therefore the VC7A crystal key
 * and the predecessor golden bytes — are unaffected by this flag.
 *
 * The flag gates ONLY the `vector_cortex_cache_experiment_assigned` /
 * `vector_cortex_cache_economics_estimated` events and the cache-economics
 * dashboard seam, which reports `enabled:false` + mode C when off. This flag
 * MUST also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS), mirroring VC4A..VC7A.
 */
export const VC7B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC7B");

/**
 * VC7C — cache miss diagnostics, cache-level breakers and the completed M5
 * request-hash-v2 switch. Default ON. `MEGACOMPACT_VC7C=0` disables and is
 * byte-identical to the predecessor (VC7B): the miss `classify`, the breaker
 * demotion decision and the M5 request-hash-v2 ARITHMETIC STILL RUN (they are
 * PURE — an exclusive ordered comparison over already-computed digests plus a
 * canonical length-prefixed SHA-256, with no clock, storage, or network), so a
 * miss is classified into the SAME single class, a collision / stale generation
 * / digest failure / profile mismatch still demotes BEFORE any cache serve, and
 * the v2 hash of a given request is unchanged with the flag off. A cache is
 * never allowed to serve a stale or colliding entry merely because reporting is
 * off — that would be a correctness change, not a reporting change.
 *
 * The flag gates ONLY the `vector_cortex_cache_miss_classified` /
 * `vector_cortex_cache_serve_blocked` events and the cache-diagnostics dashboard
 * seam, which reports `enabled:false` + mode C when off. This flag MUST also be
 * a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS), mirroring VC4A..VC7B.
 */
export const VC7C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC7C");

/**
 * VC8A — consent-bound outcome ledger + offline learning dataset. Default ON.
 * `MEGACOMPACT_VC8A=0` disables and is byte-identical to the predecessor
 * (VC7C): the outcome ledger, consent records, and dataset manifest builder
 * STILL RUN (they are PURE — append-only validation, consent evaluation, and
 * SHA-256 digests, with no clock, storage, or network), so an outcome is still
 * validated identically and a consent revocation still excludes a row. The
 * flag gates ONLY the `vector_cortex_outcome_appended` /
 * `vector_cortex_dataset_record_excluded` events and the outcomes dashboard
 * seam, which reports `enabled:false` + mode C when off. This flag MUST also be
 * a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS), mirroring VC4A..VC7C.
 */
export const VC8A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC8A");

/**
 * VC8B — bounded shadow adaptive policy + M7 pressure-v2. Default ON.
 * `MEGACOMPACT_VC8B=0` disables and is byte-identical to the predecessor
 * (VC8A): the policy engine, shadow evaluator, and M7 migration STILL RUN
 * (they are PURE — action validation, budget clamping, pressure canonicalization
 * and copy/validate/switch, with no clock, storage, or network), so a budget is
 * still clamped identically and an unknown pressure label is still rejected. The
 * flag gates ONLY the `vector_cortex_shadow_decision_recorded` /
 * `vector_cortex_policy_action_rejected` events and the policy dashboard seam,
 * which reports `enabled:false` + mode C when off. This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring VC4A..VC8A.
 */
export const VC8B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC8B");

// VC8C (canary selection + external Rust parity) extracted to
// vector-cortex-vc8c.ts to keep this file under the 300-line soft limit.
// Re-exported here so every existing `from "./config/vector-cortex.js"`
// import keeps resolving unchanged.
export { VC8C_ENABLED } from "./vector-cortex-vc8c.js";

// VC9A/VC9B/VC9C/VC9D split to vector-cortex-vc9{a,b,c,d}.ts to stay under the 300-line soft limit.
export { VC9A_ENABLED } from "./vector-cortex-vc9a.js";
export { VC9B_ENABLED } from "./vector-cortex-vc9b.js";
export { VC9C_ENABLED } from "./vector-cortex-vc9c.js";
export { VC9D_ENABLED } from "./vector-cortex-vc9d.js";
export { PCC_ENABLED } from "./vector-cortex-pcc.js";

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
