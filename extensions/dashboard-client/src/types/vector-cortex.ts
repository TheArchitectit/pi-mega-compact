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
