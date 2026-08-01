/**
 * tiered-router/types.ts — S44 tiered router types, interfaces, and defaults.
 *
 * Shell file: pure data/type definitions. Zero runtime dependencies on store
 * internals. Imported by tieredRouter.ts and any consumer that needs the
 * RecallResult / TieredRouterMetrics shapes.
 */

import type { SearchHit } from "../vectorStore.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TieredRecallOpts {
  /** Session ID to scope search. When absent, searches cross-session. */
  sessionId?: string;
  /** Max number of results to return (default 10). */
  k?: number;
  /** Skip LRU-cache lookup (force L1 hit). */
  bypassCache?: boolean;
  /**
   * FTS5 max BM25 score for the L1 confidence gate.
   * Read from calibration.json at construction; overridable per-call.
   */
  overrideFts5MaxBm25?: number;
}

export interface RecallResult {
  /** Checkpoint search hits, ranked by relevance. */
  hits: SearchHit[];
  /** Which tier produced the result. */
  tier: "L0" | "L1" | "L2";
  /** Per-tier latency deltas in ms (contains only tiers that ran). */
  latencyMs: { l0?: number; l1?: number; l2?: number };
}

export interface TieredRouterMetrics {
  l0Hits: number;
  l0Misses: number;
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  totalQueries: number;
  avgLatencyMs: { l0: number; l1: number; l2: number };
  fts5MaxBm25: number | null;
  uncalibrated: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default LRU cache size. */
export const DEFAULT_CACHE_SIZE = 256;

/** Default latency budgets per tier (ms). */
export const DEFAULT_BUDGET_L0_MS = 1;
export const DEFAULT_BUDGET_L1_MS = 50;
export const DEFAULT_BUDGET_L2_MS = 500;

/** Default cadence for tiered-metrics logging (every N queries). */
export const DEFAULT_LOG_CADENCE = 100;
