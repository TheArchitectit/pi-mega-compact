/**
 * rrf.ts — Reciprocal Rank Fusion (RRF) for merging ranked lists (S43A-7).
 *
 * Pure function: takes multiple ranked lists and returns a single fused ranking
 * using the standard RRF formula.
 *
 * Reference: Cormack, G.V., Clarke, C.L.A., Buettcher, S. "Reciprocal Rank
 * Fusion Outperforms Condorcet and Individual Rank Learning Methods."
 * SIGIR 2009.
 */

/**
 * Items with their original rank position (1-based).
 */
export interface RankedItem {
  id: string;
  rank: number;
}

/**
 * Items with fused RRF score.
 */
export interface FusedItem {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists into a single score.
 * Uses the standard RRF formula: score(id) = sum(1 / (k + rank_i(id))).
 *
 * k defaults to 60 — the canonical value from Cormack et al. 2009.
 * Higher k reduces the impact of high rankings; lower k gives more weight to
 * top-ranked items.
 */
export function reciprocalRankFusion(
  lists: RankedItem[][],
  k: number = 60,
): FusedItem[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    for (const item of list) {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
