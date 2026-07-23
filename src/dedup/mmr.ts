/**
 * mmr.ts — Maximal Marginal Relevance reranking for retrieval diversity
 * (Sprint 12, QA #10).
 *
 * After a relevance-ranked candidate list, MMR reorders so we don't inject a
 * cluster of near-identical checkpoints. Each step picks the candidate that
 * maximizes `λ·relevance − (1−λ)·maxSimToAlreadySelected`, balancing relevance
 * against redundancy. λ=0.5 is the default (equal weight).
 *
 * Pure function over cosine similarities — no deps, no network (PREVENT-PI-004).
 */

import type { Vector } from "../embedder.js";
import { cosineSimilarity } from "../embedder.js";

export const MMR_LAMBDA = 0.5;

export interface MmrItem<T> {
  item: T;
  vector: Vector; // embedding used for redundancy scoring
  relevance: number; // base relevance score (e.g. query cosine)
}

/**
 * Rerank `items` by MMR. Returns the items in MMR order, capped at `k`.
 * `lambda` balances relevance vs diversity (1 = pure relevance, 0 = max diversity).
 */
export function mmrRerank<T>(items: MmrItem<T>[], k: number, lambda = MMR_LAMBDA): T[] {
  if (items.length === 0) return [];
  const remaining = [...items];
  const selected: MmrItem<T>[] = [];
  const cap = Math.min(k, items.length);

  while (selected.length < cap && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      // Max similarity to already-selected (redundancy penalty). For the first
      // pick (selected empty) there is no penalty — the MMR score is pure
      // relevance. We guard the penalty term on `selected.length > 0` rather
      // than initializing maxSimToSelected to -Infinity, because at λ=1 a
      // non-zero penalty of any sign must contribute exactly 0, and
      // (1−1)·(−∞) = NaN would corrupt the comparison (NaN > -Infinity is false,
      // so no candidate would ever be picked). For non-empty selected, a
      // candidate whose true max-similarity is negative correctly takes that
      // negative penalty. Benign for the default trigram embedder (cosine in
      // [0,1]) but correct for any BYO mean-centered embedder.
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const sim = cosineSimilarity(cand.vector, sel.vector);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const penalty = selected.length > 0 ? (1 - lambda) * maxSimToSelected : 0;
      const mmr = lambda * cand.relevance - penalty;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected.map((s) => s.item);
}
