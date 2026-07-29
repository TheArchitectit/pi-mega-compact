/**
 * labels.ts — S51A TF-IDF cluster labeling + membership confidence.
 *
 * Pure local math over real stored text (PREVENT-PI-004). NO fabricated keyword
 * taxonomy, NO model: a cluster's label is the top TF-IDF terms of its real member
 * chunks (real TF × real IDF over the whole corpus), so common words are
 * naturally down-weighted by IDF rather than by a hand-written stopword list.
 */

import type { EmbeddedChunk } from "./types.js";

/** Tokenize text: lowercase, split on non-alphanumeric, drop empties/1-char. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}

/**
 * Compute TF-IDF term scores for one cluster's member chunks against the whole
 * corpus. TF = term count across the cluster's members; IDF = log(1 + N/df)
 * where N = total chunks and df = chunks containing the term. Returns the full
 * list sorted by score desc.
 */
export function tfidfScores(
	memberChunks: EmbeddedChunk[],
	corpus: EmbeddedChunk[],
): Array<{ term: string; score: number }> {
	const tf = new Map<string, number>();
	for (const c of memberChunks) {
		for (const term of tokenize(c.text)) tf.set(term, (tf.get(term) ?? 0) + 1);
	}
	if (tf.size === 0) return [];

	// Document frequency over the whole corpus (one vote per chunk per term).
	const df = new Map<string, number>();
	for (const c of corpus) {
		for (const term of new Set(tokenize(c.text))) df.set(term, (df.get(term) ?? 0) + 1);
	}
	const n = Math.max(1, corpus.length);

	const out: Array<{ term: string; score: number }> = [];
	for (const [term, f] of tf) {
		const idf = Math.log(1 + n / (df.get(term) ?? 1));
		out.push({ term, score: f * idf });
	}
	out.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
	return out;
}

/** Join the top `topTerms` TF-IDF terms into a human label. */
export function labelFromScores(
	scores: Array<{ term: string; score: number }>,
	topTerms: number,
): string {
	const top = scores.slice(0, Math.max(1, topTerms)).map((s) => s.term);
	return top.length > 0 ? top.join(" · ") : "general";
}

/**
 * Normalized cosine membership confidence in [0,1]. Cosine is in [-1,1]; map to
 * [0,1] via (1 + cos)/2. A chunk sitting exactly on its centroid → 1.
 */
export function membershipConfidence(cosineSimilarity: number): number {
	return Math.max(0, Math.min(1, (1 + cosineSimilarity) / 2));
}
