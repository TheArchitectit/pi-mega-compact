/**
 * dashboard-server/types.ts — shared types for the dashboard server.
 *
 * Re-exports shared shapes from `api-contracts/` where they overlap with
 * the legacy local types, while preserving 100% backward compatibility for
 * all existing consumers (server.ts, index-reader.ts, snapshot.ts).
 */

import type { IndexesIndexRow } from "./api-contracts/multi-repo.js";
import type { SnapshotResponse } from "./api-contracts/snapshot.js";

// Active-window cutoff (seconds) for the /api/servers endpoint.
export const ACTIVE_WINDOW_SEC = 1800;

// IndexRepo fields exactly match IndexesIndexRow in api-contracts/multi-repo.ts.
export type { IndexesIndexRow as IndexRepo } from "./api-contracts/multi-repo.js";

/**
 * Per-repo summary metrics (subset of IndexesSummaryResponse — lacks
 * `updatedAt` and `repos`).
 */
export interface IndexSummary {
  totalRepos: number;
  totalCheckpoints: number;
  totalTokensSaved: number;
  totalCompressedOriginalBytes: number;
}

export type IndexIndex = { updatedAt: string; summary: IndexSummary | null; repos: IndexesIndexRow[] };

/**
 * Full dashboard snapshot — extends SnapshotResponse with a `version` field
 * used for cache-replay compatibility checks.
 */
export interface Snapshot extends SnapshotResponse {
  version: number;
}

/**
 * Minimal live snapshot shape for lightweight dashboard.json overlays.
 * No api-contracts equivalent — kept as-is.
 */
export interface LiveSnapshot { tier?: string; updatedAt?: string | null; context?: { tokens?: number | null; percent?: number | null; contextWindow?: number }; session?: { id?: string; state?: string }; cacheHits?: { session: number; total: number; sessionTokensSaved: number; totalTokensSaved: number }; compacts?: { session: number; total: number }; timeSaved?: { compact: { sessionSec: number; totalSec: number }; cacheHit: { sessionSec: number; totalSec: number } }; }
