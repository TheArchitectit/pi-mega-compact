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

// ---------------------------------------------------------------------------
// Breaker state machine constants (TRIAD_RESILIENCE.md §breaker).
// Rolled numbers for one 60s window; VC0C consumes these at its breaker seam.
// ---------------------------------------------------------------------------

/** Rolling eligibility window (milliseconds). */
export const BREAKER_WINDOW_MS = 60_000;
/** Minimum attempts before a breaker may trip or promote. */
export const BREAKER_MIN_ATTEMPTS = 20;
/** Performance trip: ≥ this many failures in window, or ≥ this fraction. */
export const BREAKER_PERF_FAILURES = 5;
export const BREAKER_PERF_FAILURE_RATE = 0.1;
/** Correctness trip trips on the first correctness failure. */
export const BREAKER_CORRECTNESS_FAILURES = 1;
/** Cooldown before an open breaker may probe (milliseconds). */
export const BREAKER_COOLDOWN_MS = 30_000;
/** Consecutive successful probes required to advance a state. */
export const BREAKER_PROBE_COUNT = 3;
/** Exponential retry base: 30s * 2^attempt, capped, ±10% jitter. */
export const BREAKER_RETRY_BASE_MS = 30_000;
export const BREAKER_RETRY_CAP_MS = 15 * 60_000;
export const BREAKER_RETRY_JITTER = 0.1;
/** Promotion hysteresis: failure rate must be < this and p95 within budget. */
export const BREAKER_HYSTERESIS_FAILURE_RATE = 0.02;
export const BREAKER_HYSTERESIS_BUDGET_P95_MS = 50;
/** Minimum healthy residence before a further promotion (milliseconds). */
export const BREAKER_MIN_HEALTHY_RESIDENCE_MS = 5 * 60_000;
