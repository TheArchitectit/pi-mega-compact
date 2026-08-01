/**
 * config/stopwords.ts — shared stopword set for query expansion, coverage
 * metrics, and term tokenization (S45, PREREQUISITE P2).
 *
 * Single source of truth: both `src/queryExpansion.ts` and `src/recallMetrics.ts`
 * import from here instead of duplicating inline sets.
 *
 * Pi-agnostic, zero deps, tree-shake safe.
 */

/** Default English stopwords. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "not", "no", "nor",
  "so", "if", "then", "than", "that", "this", "these", "those", "it",
  "its", "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "they", "them", "their", "what", "which", "who", "whom", "when",
  "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "only", "own", "same", "so", "than",
  "too", "very", "just", "about", "above", "after", "again", "against",
  "because", "before", "between", "down", "during", "out", "over",
  "through", "under", "up", "also", "into", "off", "onto", "upon",
]);
