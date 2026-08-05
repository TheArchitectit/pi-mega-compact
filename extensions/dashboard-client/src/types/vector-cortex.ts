/**
 * dashboard-client/src/types/vector-cortex.ts — vector-cortex client types.
 * Mirrors the reader-only evaluation summary (VC0A). Contains only aggregates
 * (histogram cells + counts), never payloads/prompts/ledger.
 */

export interface VectorCortexEvaluationSummary {
  enabled: boolean;
  mode: "A" | "B" | "C";
  samples: number;
  byMode: { A: number; B: number; C: number };
  histogram: {
    edges: number[];
    cells: number[];
    overflow: number;
    total: number;
  };
  rejects: string[];
  updatedAt: string;
}

/**
 * Health card (VC0C, task 5): breaker state + durable spool frontier/lag.
 * Aggregate only — never payloads/prompts/ledger.
 */
export interface VectorCortexHealthCard {
  enabled: boolean;
  mode: "A" | "B" | "C";
  state:
    | "CLOSED_A"
    | "OPEN_B"
    | "OPEN_C"
    | "PROBE_B"
    | "PROBE_A"
    | "MANUAL_HALT";
  subsystem: string;
  sinceMs: number;
  reason?: string;
  windowMs: number;
  probeCount: number;
  backoffDelayMs: number;
  frontierFrozen: boolean;
  authorityOutage: boolean;
  spoolLag: number;
  attempts: number;
  failures: number;
  p95Ms: number;
  failureRate: number;
  updatedAt: string;
  aggregate: string;
  /** "ephemeral" = per-process/in-memory breaker (non-live until VC0D). */
  stateSource: "ephemeral" | "live";
  /**
   * VC2C encoder asset digest — SHA-256 of the committed ModelManifestV1 bytes.
   * null when no qualified encoder manifest is present on this host.
   */
  encoderAssetDigest: string | null;
  /**
   * VC2C encoder triad mode: "A" when the committed asset verifies as a
   * qualified learned asset on this host/platform, else "B" (trigram) or "C"
   * (lexical).
   */
  encoderMode: "A" | "B" | "C";
}

/** Admin reset result (VC0C, task 5). */
export interface VectorCortexResetResult {
  subsystem: string;
  state: string;
  cooldownCleared: boolean;
  attempts: number;
  failures: number;
  probeCount: number;
  manualReason?: string;
  updatedAt: string;
}

/**
 * Reader-only cortex topology view (VC3A, GET /api/vector-cortex/topology).
 * Aggregate only — active generation identity, one root digest, derived frontier
 * and record count. Never append/rebuild capability or raw record payloads.
 */
export interface VectorCortexTopologyView {
  enabled: boolean;
  generationId: string | null;
  rootDigest: string | null;
  sourceHighWater: string;
  recordCount: number;
  ordinal: string | null;
  /**
   * VC3B deterministic topology node/edge shapes. Present only when the VC3B
   * flag is on; flag-off omits them (byte-identical predecessor view).
   */
  nodes?: Array<{ id: string; kind: string }>;
  edges?: Array<{
    source: string;
    target: string;
    head: string;
    score: number;
    direction: string;
  }>;
  generationDigest?: string | null;
  updatedAt: string;
}

/**
 * Reader-only query-layer diagnostics view (VC3C, GET /api/vector-cortex/query).
 * Purely a flag-status + structural diagnostic: VC3C flag enabled state and the
 * router-generation v2 version constant. Aggregate only — the in-memory query
 * index is not durable and never exposes payloads/prompts.
 */
export interface VectorCortexQueryView {
  enabled: boolean;
  routerVersion: number;
  updatedAt: string;
}

/**
 * Dual-tier shard aggregate (VC4A, GET /api/vector-cortex/shards).
 * Reader-only count/byte aggregate — never shard payloads or verbatim bytes.
 */
export interface VectorCortexShardsView {
  enabled: boolean;
  semanticCount: number;
  exactCount: number;
  byteTotal: number;
  protectedByteTotal: number;
  updatedAt: string;
}

/**
 * Reconstruction-fidelity aggregate (VC4C, GET /api/vector-cortex/reconstruct).
 * Reader-only: closure/validation counts + byte totals, never reconstructed
 * spans, exact bytes, or prompt text.
 */
export interface VectorCortexReconstructView {
  enabled: boolean;
  closureAttempts: number;
  closureRejections: number;
  validatedCount: number;
  invalidatedCount: number;
  spanTotal: number;
  byteTotal: number;
  updatedAt: string;
}

/**
 * Occurrence-ledger identity view (VC1B, GET /api/vector-cortex/ledger).
 * Reader-only: seq/eventId/kind/digest + high-water, never source payloads.
 */
export interface VectorCortexLedgerView {
  enabled: boolean;
  session: string;
  highWater: string;
  count: number;
  occurrences: Array<{
    seq: string;
    eventId: string;
    kind: string;
    digest: string;
    toolCallId?: string;
  }>;
  updatedAt: string;
}

/**
 * Plan manifest (VC5A, GET /api/vector-cortex/plans). Reader-only: registered
 * DAG/PLN counts + plan manifests, never session payloads or prompt text.
 */
export interface VectorCortexPlanManifest {
  id: string;
  mandatoryInBudget: boolean;
  selectedNodeIds: string[];
  tokenTotal: number;
  demotedToC: boolean;
}

export interface VectorCortexPlansView {
  enabled: boolean;
  dagCount: number;
  plannerCount: number;
  plans: VectorCortexPlanManifest[];
  updatedAt: string;
}

/** Reader-only render + provider-profile view (VC5B). */
export interface VectorCortexRenderView {
  enabled: boolean;
  renderCount: number;
  providerCount: number;
  knownProfiles: string[];
  updatedAt: string;
}

/**
 * Reader-only live graduated-rollout view (VC5C, GET /api/vector-cortex/rollout).
 * Aggregate only — current gate, bucket count, sessions/events counts, promotion
 * state. Never session payloads or bucket→session mappings.
 */
export interface VectorCortexRolloutView {
  enabled: boolean;
  gateIndex: number;
  gatePct: number;
  buckets: number;
  bucketCount: number;
  events: number;
  sessions: number;
  promotionBlocked: boolean;
  updatedAt: string;
}

/**
 * Reader-only exact-source-restoration view (VC6B). Counts + HEAL_RESTORE_*
 * codes only — there is no payload endpoint, so no restored bytes, span ids,
 * node ids, or ledger text ever reach the client.
 */
export interface VectorCortexRestoreView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  restoreAttempts: number;
  restoredCount: number;
  missingCount: number;
  digestRejections: number;
  lastRejection: string | null;
  updatedAt: string;
}

/**
 * Reader-only self-healing derived-state view (VC6C). Counts + HEAL_REPAIR_*
 * codes only — there is no payload endpoint, so no subsystem source bytes, gap
 * ranges, high-water marks, root digests, or ledger text ever reach the client.
 */
export interface VectorCortexRepairView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  repairAttempts: number;
  repairsPlanned: number;
  pointersSwitched: number;
  backoffs: number;
  lastBackoffMs: number | null;
  lastFailure: string | null;
  updatedAt: string;
}

/** Reader-only closure-optimization diagnostics view (VC6A). Aggregate only. */
export interface VectorCortexClosureProofView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  optimizations: number;
  proofRejections: number;
  retainedEdgeTotal: number;
  removedEdgeTotal: number;
  conservativeTraversalTotal: number;
  optimizedTraversalTotal: number;
  lastRejection: string | null;
  updatedAt: string;
}

export type {
  VectorCortexCrystalsView,
  VectorCortexEconomicsView,
  VectorCortexDiagnosticsView,
} from "./vector-cortex-vc7.js";

export type { VectorCortexOutcomesView, VectorCortexPolicyView, VectorCortexPlatformView } from "./vector-cortex-vc8.js";
