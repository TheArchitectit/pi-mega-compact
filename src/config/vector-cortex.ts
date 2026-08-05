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

/** Positive sprint flag: `=0` or `_DISABLED=true` disables (default ON). */
function sprintFlag(name: string): boolean {
  const v = process.env[name];
  if (v === "0" || v === "false") return false;
  const disabled = process.env[name + "_DISABLED"];
  if (disabled === "true" || disabled === "1") return false;
  return true;
}

/** VC0A — baseline observability (MetricEventV1 / AnnotationV1). Default ON. */
export const VC0A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0A");

/**
 * VC0B — replay correctness (ReplayCutV2 / ReplayReportV2, M3 effective-cut-v2).
 * Default ON. `MEGACOMPACT_VC0B=0` disables and is byte-identical to the
 * predecessor (legacy capped-replay behavior preserved; the v2 cut/replay is
 * only consulted on the vector-cortex path).
 */
export const VC0B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0B");

/**
 * VC1A — canonical byte events (EventV2 / EventCodec).
 * Default ON. `MEGACOMPACT_VC1A=0` disables and is byte-identical to the
 * predecessor (mode C: ledger absent, current transcript codec unchanged).
 * The single real consumer is the ledger emit seam (`ledger/emit.ts`): flag OFF
 * gates zero observability writes.
 */
export const VC1A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1A");

/**
 * VC1B — occurrence ledger + tool identity + compat journal (LedgerReader/
 * Writer/Admin, CompatJournalV1, M2 occurrence-v2 migration).
 * Default ON. `MEGACOMPACT_VC1B=0` disables and is byte-identical to the
 * predecessor (mode C: the neutral occurrence ledger is not written, no
 * journal rows, zero `vector_cortex_occurrence_appended` emissions). The real
 * consumers are the ledger write integration seam and the compat-journal
 * switch seam.
 */
export const VC1B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1B");

/**
 * VC0C — live safety envelope (TriadResult / Breaker / KillDecision + durable
 * spool). Default ON. `MEGACOMPACT_VC0C=0` disables and is byte-identical to
 * the predecessor (mode C: selected before provider invocation, unchanged host
 * transcript, breaker/spool idle and emitting nothing). The single real
 * consumer is the resilience emit seam + the safety adapter's triad selection.
 */
export const VC0C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0C");

/**
 * VC1C — cross-language conformance v2 (FixtureManifestV2 / DowngradeReport /
 * MinHashV2 + M4 minhash-v2 migration).
 * Default ON. `MEGACOMPACT_VC1C=0` disables and is byte-identical to the
 * predecessor (mode C: a v2 conformance runner that accepts authority fixtures
 * and the manifest validator idle; the sync dedup scan stays on the v1 path;
 * zero `vector_cortex_*` VC1C emissions). The real consumers are the conformance
 * emit seam, the minhash-v2 backfill seam and the downgrade-export seam.
 */
export const VC1C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1C");

/**
 * VC2A — offline model runtime and asset decision (ModelManifestV1 /
 * EncoderRuntime).
 * Default ON. `MEGACOMPACT_VC2A=0` disables and is byte-identical to the
 * predecessor (mode C: no asset manifest is read/verified, the encoder runtime
 * idles in mode C, zero `vector_cortex_encoder_*` emissions; the trigram/lexical
 * paths are unchanged). The real consumers are the encoder emit seam and the
 * encoder runtime's A/B/C selection.
 */
export const VC2A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC2A");

/**
 * VC2B — multi-head encoder (VectorSetV1 / HeadCalibrationDraft).
 * Default ON. `MEGACOMPACT_VC2B=0` disables and is byte-identical to the
 * predecessor (the encoder emits no per-head vectors and no fallback-selected
 * event; the trigram/lexical paths themselves are unchanged and are the
 * predecessor's mode-B/C producers). The real consumers are the encoder-heads
 * emit seam and the multi-head encoder producers (heads/trigram/lexical).
 */
export const VC2B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC2B");

/**
 * VC2C — encoder qualification + calibration (QualifiedEncoderV1 / CalibrationV1).
 * Default ON. `MEGACOMPACT_VC2C=0` disables and is byte-identical to the
 * predecessor (mode C: no qualification manifest is read or selected, the
 * calibrate/select/fallback seams are idle, zero `vector_cortex_encoder_qualification_*`
 * emissions; the trigram/lexical paths are unchanged). The real consumers are
 * the encoder-qualification emit seam and the calibrate/select seams.
 */
export const VC2C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC2C");

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

// Breaker state machine constants (TRIAD_RESILIENCE.md §breaker) extracted to
// vector-cortex-breakers.ts to keep this file under the 300-line soft limit.
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
