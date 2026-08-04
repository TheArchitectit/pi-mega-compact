/**
 * api-contracts/vector-cortex.ts — vector-cortex dashboard API contracts.
 *
 * Owned by the vector-cortex sprints. VC0A ships only the reader-only aggregate
 * `GET /api/vector-cortex/evaluation`. VC0C adds the breaker health endpoint
 * and reset mutation into this SAME file — keep entries small and additive so
 * the file stays within extension limits (400 soft / 500 hard).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/**
 * Aggregate evaluation summary for GET /api/vector-cortex/evaluation.
 * Reader-only: exposes aggregates (histogram cells, counts), never payloads or
 * exact ledger text.
 */
export interface VectorCortexEvaluationSummary {
  /** Whether the VC0A observer flag is enabled in this process. */
  readonly enabled: boolean;
  /** Triad observer mode reflected in the summary ("C" when observer absent). */
  readonly mode: "A" | "B" | "C";
  /** Total evaluation samples aggregated. */
  readonly samples: number;
  /** Per-mode sample distribution. */
  readonly byMode: {
    readonly A: number;
    readonly B: number;
    readonly C: number;
  };
  /** Fixed latency histogram (inclusive edges, separate overflow). */
  readonly histogram: {
    readonly edges: readonly number[];
    readonly cells: readonly number[];
    readonly overflow: number;
    readonly total: number;
  };
  /** Evaluator rejections (EVAL_*) observed in this window. */
  readonly rejects: readonly string[];
  /** ISO timestamp of the summary. */
  readonly updatedAt: string;
}

/**
 * Health-card aggregate for GET /api/vector-cortex/health. Reader-only: exposes
 * breaker state, window/probe/backoff, and durable spool frontier/authority/lag
 * aggregates — never payloads, prompts, or exact ledger text.
 */
export interface VectorCortexHealthCard {
  /** Whether the VC0C safety envelope is enabled in this process. */
  readonly enabled: boolean;
  /** Selected triad mode ("A" healthy, "B" spool fallback, "C" unchanged). */
  readonly mode: "A" | "B" | "C";
  /** Breaker state: CLOSED_A | OPEN_B | OPEN_C | PROBE_B | PROBE_A | MANUAL_HALT. */
  readonly state: string;
  /** Tracked subsystem (this shell owns the "provider" breaker). */
  readonly subsystem: string;
  /** Milliseconds since the last transition. */
  readonly sinceMs: number;
  /** Manual halt reason, when MANUAL_HALT. */
  readonly reason?: string;
  /** Rolling window length (ms). */
  readonly windowMs: number;
  /** Consecutive successful probes. */
  readonly probeCount: number;
  /** Current exponential backoff delay (ms). */
  readonly backoffDelayMs: number;
  /** Derived frontier frozen by an authority outage. */
  readonly frontierFrozen: boolean;
  /** Authority (mode-A ledger) currently in outage. */
  readonly authorityOutage: boolean;
  /** Durable spool unacknowledged tail (records awaiting authority commit). */
  readonly spoolLag: number;
  /** Rolling window attempt count. */
  readonly attempts: number;
  /** Rolling window failure count. */
  readonly failures: number;
  /** Rolling window p95 latency (ms). */
  readonly p95Ms: number;
  /** Rolling window failure rate (0..1). */
  readonly failureRate: number;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  /** Worst aggregate state across all health cards (this shell has one). */
  readonly aggregate: string;
  /**
   * Breaker state source. "ephemeral" (the ONLY value until VC0D) = this breaker
   * is per-process/in-memory, rebuilt on every request — NOT a live persistent
   * breaker; the dashboard/README must not present it as live. "live" appears
   * only once the persistent breaker runtime + producer wiring land (VC0D).
   */
  readonly stateSource: "ephemeral" | "live";
  /**
   * VC2C encoder asset digest — SHA-256 of the committed ModelManifestV1 bytes.
   * null when no qualified encoder manifest is present on this host.
   */
  readonly encoderAssetDigest: string | null;
  /**
   * VC2C encoder triad mode: "A" when the committed asset verifies as a
   * qualified learned asset on this host/platform, else "B" (trigram) or "C"
   * (lexical). Reader-only aggregate — the measured digest prefix, never bytes.
   */
  readonly encoderMode: "A" | "B" | "C";
}

/**
 * Response for POST /api/vector-cortex/breakers/reset. Admin capability: clears
 * cooldown but never evidence (failures/attempts retained) or unwires a
 * MANUAL_HALT. Returns the post-reset breaker record (aggregate, never payloads).
 */
export interface VectorCortexResetResult {
  readonly subsystem: string;
  readonly state: string;
  readonly cooldownCleared: boolean;
  readonly attempts: number;
  readonly failures: number;
  readonly probeCount: number;
  readonly manualReason?: string;
  readonly updatedAt: string;
}

/**
 * Reader-only cortex topology view for GET /api/vector-cortex/topology (VC3A).
 * Built on the CortexReader capability surface ONLY — it exposes the flagged
 * enabled state, active generation identity, one root digest, derived frontier
 * and record count, and NEVER append/rebuild capability or raw record payloads.
 */
export interface VectorCortexTopologyView {
  /** Whether the VC3A cortex-store flag is enabled in this process. */
  readonly enabled: boolean;
  /** Active generation id, or null when none rebuilt yet. */
  readonly generationId: string | null;
  /** Active generation root digest, or null. */
  readonly rootDigest: string | null;
  /** Derived frontier (active generation sourceHighWater, else "0"). */
  readonly sourceHighWater: string;
  /** Accepted derived record count. */
  readonly recordCount: number;
  /** Monotonic rebuild ordinal, or null. */
  readonly ordinal: string | null;
  /**
   * VC3B deterministic topology node/edge shapes — present ONLY when the VC3B
   * flag is enabled (flag-off omits them, byte-identical to the VC3A
   * predecessor view). Built reader-only from the accepted derived records and
   * best-effort: an unavailable or un-stored graph degrades to empty arrays,
   * never an error. The exact node (`id`/`kind`) and edge
   * (`source`/`target`/`head`/`score`/`direction`) shapes match TopologyV1.
   */
  readonly nodes?: readonly { id: string; kind: string }[];
  readonly edges?: readonly {
    source: string;
    target: string;
    head: string;
    score: number;
    direction: string;
  }[];
  /** Stable graph generation digest (VC3B), when the graph was built. */
  readonly generationDigest?: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}

/**
 * Reader-only query-layer diagnostics view for GET /api/vector-cortex/query
 * (VC3C). Purely a flag-status + structural diagnostic — reports whether the
 * VC3C flag is enabled and the router-generation v2 version constant. The VC3C
 * query index is in-memory (not durable), so no payloads, prompts, or index
 * contents are ever exposed. Non-fatal: a missing state dir or internal error
 * degrades to `enabled:false`.
 */
export interface VectorCortexQueryView {
  /** Whether the VC3C query-layer flag is enabled in this process. */
  readonly enabled: boolean;
  /** Router-generation v2 key version constant (query index format). */
  readonly routerVersion: number;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}

/**
 * Reader-only occurrence-ledger view for GET /api/vector-cortex/ledger (VC1B).
 * Built on the LedgerReader capability surface. Exposes occurrence IDENTITY
 * (seq/eventId/kind/digest/toolCallId) and the per-session high-water/count —
 * NEVER sourceBytes or prompt text, honoring the reader-only no-ledger-text rule.
 */
export interface VectorCortexLedgerView {
  /** Whether the VC1B occurrence ledger flag is enabled in this process. */
  readonly enabled: boolean;
  /** The ledger session whose occurrences are returned. */
  readonly session: string;
  /** Durable contiguous high-water (stringified bigint) for the session. */
  readonly highWater: string;
  /** Number of accepted occurrences for the session. */
  readonly count: number;
  /** Capped identity rows (ascending seq). No source bytes, never payload text. */
  readonly occurrences: readonly {
    readonly seq: string;
    readonly eventId: string;
    readonly kind: string;
    readonly digest: string;
    readonly toolCallId?: string;
  }[];
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}
