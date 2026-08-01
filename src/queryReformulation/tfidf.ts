/**
 * tfidf.ts — TF-IDF term extraction from neighbor documents (S43A-6).
 *
 * Extracts the highest-IDF-weighted terms from a set of neighbor documents
 * for query expansion.
 *
 * Term frequency = raw count of the term in the neighbor document (normalized
 * by document length for cross-doc comparability).
 * Inverse document frequency = log(N / df) where N = total docs in corpus.
 *
 * This is NOT a stopword list: frequent terms like "the" naturally get a low
 * IDF and rank below rare terms like "jwt" even when both have similar TF.
 */

export interface CorpusStats {
  totalDocs: number;
  docFreq: (term: string) => number;
}

interface NeighborText {
  id: string;
  text: string;
}

/**
 * Extract the top-N terms by TF-IDF weight from the given neighbor documents.
 *
 * Returns an empty array when:
 *   - neighbors list is empty
 *   - totalDocs <= 0
 *   - no terms survive filtering (all numeric, all single-char, etc.)
 */
export function extractExpansionTerms(
  neighbors: NeighborText[],
  corpus: CorpusStats,
  topTerms: number,
): Array<{ term: string; tfIdf: number; df: number }> {
  if (neighbors.length === 0) return [];
  const { totalDocs, docFreq } = corpus;
  if (totalDocs <= 0) return [];

  // Aggregate term frequency across all neighbor documents
  const termTf = new Map<string, number>();

  for (const neighbor of neighbors) {
    const words = neighbor.text.toLowerCase().split(/\W+/).filter(Boolean);
    if (words.length === 0) continue;

    // Normalize TF by document length so longer docs don't dominate
    const lenNorm = words.length;

    for (const word of words) {
      // Skip pure number tokens (short numbers)
      if (/^\d+$/.test(word) && word.length <= 4) continue;
      // Skip single characters
      if (word.length < 2) continue;

      // Accumulate across neighbors (multiple docs amplify a term's importance)
      termTf.set(word, (termTf.get(word) ?? 0) + (1 / lenNorm));
    }
  }

  // Compute TF-IDF for each term
  const scored: Array<{ term: string; tfIdf: number; df: number }> = [];

  for (const [term, tf] of termTf) {
    const df = docFreq(term);
    // IDF = ln(1 + (N - df + 0.5) / (df + 0.5)) — smooth version
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const tfIdf = tf * idf;
    if (tfIdf > 0) {
      scored.push({ term, tfIdf, df });
    }
  }

  // Sort by TF-IDF descending, take top N
  scored.sort((a, b) => b.tfIdf - a.tfIdf);
  return scored.slice(0, topTerms);
}
