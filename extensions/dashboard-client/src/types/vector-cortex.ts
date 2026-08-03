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
