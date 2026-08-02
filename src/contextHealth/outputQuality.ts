/**
 * outputQuality.ts — pure assistant-output text quality detectors.
 *
 * No I/O beyond the injected Embedder (which is fully local / PREVENT-PI-004).
 * All functions are deterministic and side-effect free.
 */
import type { Embedder } from "../embedder.js";
import { cosineSimilarity } from "../embedder.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Tokenize on whitespace; skip empty tokens. */
function tokenizeWords(text: string): string[] {
	return text.split(/\s+/).filter((w) => w.length > 0);
}

/** Split on sentence-terminating punctuation; skip empty. */
function splitSentences(text: string): string[] {
	return text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// ─── Detectors ─────────────────────────────────────────────────────────────

/**
 * Repetition ratio via 3-gram overlap.
 *
 * Builds sliding 3-word windows over the token stream. Returns the fraction
 * of 3-grams that appear more than once (i.e. are repeated). Range 0–1;
 * values above 0.30 signal likely garbled / looping output.
 */
export function detectRepetition(text: string): number {
	const words = tokenizeWords(text);
	if (words.length < 3) return 0;
	const count = new Map<string, number>();
	for (let i = 0; i <= words.length - 3; i++) {
		const gram = words.slice(i, i + 3).join(" ");
		count.set(gram, (count.get(gram) ?? 0) + 1);
	}
	const total = words.length - 2;
	if (total === 0) return 0;
	let repeated = 0;
	for (const n of count.values()) {
		if (n > 1) repeated += n;
	}
	// Each duplicate occurrence beyond the first adds to the repeated count.
	// Clamp total to total_3grams so the ratio stays in [0,1].
	return Math.min(1, repeated / total);
}

/**
 * Sentence-level coherence score via adjacent cosine similarity.
 *
 * Splits text into sentences, embeds each, and computes the cosine similarity
 * between every consecutive pair. Returns the average. Range 0–1 (higher =
 * more coherent); fewer than 2 sentences returns 1.0 (cannot measure).
 */
export function detectCoherence(text: string, embedder: Embedder): number {
	const sentences = splitSentences(text);
	if (sentences.length < 2) return 1.0;

	let sum = 0;
	let pairCount = 0;
	for (let i = 0; i < sentences.length - 1; i++) {
		const a = embedder.embed(sentences[i]);
		const b = embedder.embed(sentences[i + 1]);
		sum += cosineSimilarity(a, b);
		pairCount++;
	}
	return pairCount > 0 ? sum / pairCount : 1.0;
}

/**
 * Token-salad detector.
 *
 * A word is "recognized" if it has length ≥ 2 AND contains at least one vowel
 * (a / e / i / o / u, case-insensitive). Returns the fraction of unrecognized
 * words. Values above 0.6 suggest scrambled / token-confused output.
 */
export function detectTokenSalad(text: string): number {
	const words = tokenizeWords(text);
	if (words.length === 0) return 0;

	const VOWELS = /[aeiou]/i;
	let unrecognized = 0;
	for (const w of words) {
		if (w.length < 2 || !VOWELS.test(w)) unrecognized++;
	}
	return unrecognized / words.length;
}

/**
 * True when the output is entirely absent or whitespace-only.
 */
export function detectEmptyOutput(text: string): boolean {
	return text.trim().length === 0;
}

// ─── Composite ─────────────────────────────────────────────────────────────

/**
 * Compute the full output-quality profile for assistant output text.
 *
 * Returns a score 0–1 (1 = healthy) and the three sub-diagnostics.
 *
 * Penalty weights (sum to 1.0):
 *   repetition  40% — repeated 3-grams are the strongest corruption signal
 *   coherence   30% — incoherent sentence transitions
 *   salad       30% — garbage tokens
 *
 * Empty output is a hard 0.0 (nothing to evaluate).
 */
export function computeOutputQuality(
	text: string,
	embedder: Embedder,
): {
	score: number;
	repetitionRatio: number;
	coherenceScore: number;
	isEmpty: boolean;
} {
	const isEmpty = detectEmptyOutput(text);
	if (isEmpty) {
		return { score: 0.0, repetitionRatio: 0, coherenceScore: 1.0, isEmpty: true };
	}

	const repetitionRatio = detectRepetition(text);
	const coherenceScore = detectCoherence(text, embedder);
	const saladRatio = detectTokenSalad(text);

	const repetitionPenalty = repetitionRatio * 0.4;
	const coherencePenalty = (1 - coherenceScore) * 0.3;
	const saladPenalty = saladRatio * 0.3;

	const score = Math.max(0, Math.min(1,
		1.0 - repetitionPenalty - coherencePenalty - saladPenalty,
	));

	return { score, repetitionRatio, coherenceScore, isEmpty: false };
}