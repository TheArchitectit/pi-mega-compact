/**
 * l1-verify.ts — trigram-similarity verification gate for L1 near-duplicates
 * (Sprint 11).
 *
 * After LSH cheaply retrieves candidate chunk_ids, we apply a REAL similarity
 * check before declaring a duplicate. This is the `pg_trgm`-equivalent final
 * gate: we compute the trigram (character 3-gram) Jaccard / overlap similarity
 * between the new normalized text and each candidate's normalized text.
 *
 * We compute it in TS (not via FTS5 MATCH, which is boolean) so we get a stable
 * [0,1] score to threshold against (0.85 per spec). The FTS5 `trigram` table is
 * still maintained for future query-path use, but verification is pure TS so its
 * result is deterministic and unit-testable (PREVENT-PI-004).
 */

import { normalize } from "./normalize.js";

const TRIGRAM_SIZE = 3;
export const L1_VERIFY_THRESHOLD = 0.85;

/** Extract the set of character trigrams from normalized text. */
function trigrams(text: string): Set<string> {
  const norm = normalize(text);
  const set = new Set<string>();
  if (norm.length === 0) return set;
  if (norm.length < TRIGRAM_SIZE) {
    set.add(norm);
    return set;
  }
  for (let i = 0; i + TRIGRAM_SIZE <= norm.length; i++) {
    set.add(norm.slice(i, i + TRIGRAM_SIZE));
  }
  return set;
}

/**
 * Trigram similarity in [0,1]. We use overlap coefficient (|A∩B| / min(|A|,|B|))
 * which, like pg_trgm's `similarity`, is robust when one text is a substring of
 * the other — better than Jaccard for the near-dup "one-word edit" case.
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = smaller === ta ? tb : ta;
  for (const g of smaller) if (larger.has(g)) inter++;
  return inter / smaller.size;
}

/** True when `a` and `b` are near-duplicates under the L1 threshold. */
export function isNearDuplicate(a: string, b: string, threshold = L1_VERIFY_THRESHOLD): boolean {
  return trigramSimilarity(a, b) >= threshold;
}
