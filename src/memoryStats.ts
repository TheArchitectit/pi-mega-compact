/**
 * memoryStats.ts — aggregate memory-store statistics (S53B).
 *
 * Reads from the durable SQLite memories table to produce:
 *   - totalMemories: all memories in the store
 *   - memoriesInLast30Days: memories created within the last 30 days
 *   - topStableMemories: top-N memories by recall count (desc)
 *   - avgRecallScore: mean recallCount across all memories
 *
 * recallCount = 1 if last_recalled_at IS NOT NULL, else 0.
 * This is the durable signal from recallMemory() — a memory that was
 * recalled at least once is "stable" (still relevant).  The exact recall
 * frequency is tracked via turn_recall rows (source='memory') for
 * cross-session analysis, but the memories table provides a reliable
 * on-store signal that is always present without a schema migration.
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
    // recallCount: 1 if last_recalled_at IS NOT NULL (recalled at least once),
    //             0 otherwise.  Stable memories score high.
    const topRows = db
      .prepare(
        `SELECT
           m.id,
           m.content         AS text,
           m.last_recalled_at AS lastRecalledAt,
           CASE WHEN m.last_recalled_at IS NOT NULL THEN 1 ELSE 0 END AS recallCount
         FROM memories m
         ORDER BY recallCount DESC, m.id ASC
         LIMIT ?`,
      )
      .all(topN) as Array<Record<string, unknown>>;

    // avgRecallScore = (count of recalled memories) / totalMemories.
    // This represents the fraction of memories that are "stable" (recalled at least once).
    const recalledRow = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE last_recalled_at IS NOT NULL",
      )
      .get() as { n: number };
    const avgRecallScore =
      totalMemories > 0 ? recalledRow.n / totalMemories : 0;

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