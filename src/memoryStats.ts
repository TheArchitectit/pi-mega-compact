/**
 * memoryStats.ts — aggregate memory-store statistics (S53B).
 *
 * Reads from the durable SQLite memories table to produce:
 *   - totalMemories: all memories in the store
 *   - memoriesInLast30Days: memories created within the last 30 days
 *   - topStableMemories: top-N memories by recall count (desc)
 *   - avgRecallScore: mean recallCount across all memories
 *
 * Real-store only (PREVENT-PI-004). No mocks. No network.
 */
import { openStore } from "./store/sqlite/utils.js";

export interface MemoryStatsResult {
  totalMemories: number;
  memoriesInLast30Days: number;
  topStableMemories: Array<{
    id: number;
    text: string;
    recallCount: number;
    lastRecalledAt: number | null;
  }>;
  avgRecallScore: number;
}

export interface MemoryStatsOptions {
  /** Max memories in topStableMemories (default 5). */
  topN?: number;
}

/**
 * Aggregate memory statistics from the SQLite store.
 * Always returns a valid MemoryStatsResult; never throws.
 */
export async function memoryStats(
  stateDir: string,
  opts: MemoryStatsOptions = {},
): Promise<MemoryStatsResult> {
  const topN = opts.topN ?? 5;
  try {
    const db = openStore(stateDir);
    // ── totalMemories ──────────────────────────────────────────────────────
    const totalRow = db
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number };
    const totalMemories = totalRow.n;

    // ── memoriesInLast30Days ───────────────────────────────────────────────
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const recentRow = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?",
      )
      .get(thirtyDaysAgo) as { n: number };
    const memoriesInLast30Days = recentRow.n;

    // ── topStableMemories + avgRecallScore ─────────────────────────────────
    // topStableMemories: ORDER BY recall_count DESC, id ASC (tiebreak).
    // recall_count is the number of times the memory was recalled
    // (count of rows in turn_recall with source='memory' referencing this memory id).
    // avgRecallScore: mean recall_count across ALL memories.
    const topRows = db
      .prepare(
        `SELECT
           m.id,
           m.content      AS text,
           m.last_recalled_at AS lastRecalledAt,
           (SELECT COUNT(*) FROM turn_recall tr
            WHERE tr.checkpoint_id = 'memory_' || m.id
              AND tr.source = 'memory') AS recallCount
         FROM memories m
         ORDER BY recallCount DESC, m.id ASC
         LIMIT ?`,
      )
      .all(topN) as Array<Record<string, unknown>>;

    // Compute avgRecallScore in a single pass over all memories.
    const avgRow = db
      .prepare(
        `SELECT AVG(sub.cnt) AS avgScore FROM (
           SELECT COUNT(*) AS cnt FROM turn_recall tr
           WHERE tr.source = 'memory'
           GROUP BY tr.checkpoint_id
           HAVING 1=1
         ) sub`,
      )
      .get() as { avgScore: number | null };

    const avgRecallScore =
      avgRow.avgScore !== null && Number.isFinite(avgRow.avgScore)
        ? avgRow.avgScore
        : 0;

    const topStableMemories = topRows.map((r) => ({
      id: r.id as number,
      text: (r.text as string) ?? "",
      recallCount: (r.recallCount as number) ?? 0,
      lastRecalledAt: (r.lastRecalledAt as number | null) ?? null,
    }));

    return { totalMemories, memoriesInLast30Days, topStableMemories, avgRecallScore };
  } catch {
    // Non-fatal: return zeros rather than propagating an error.
    return {
      totalMemories: 0,
      memoriesInLast30Days: 0,
      topStableMemories: [],
      avgRecallScore: 0,
    };
  }
}