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
