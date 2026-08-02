/**
 * drift.ts — rolling-window context drift detectors.
 *
 * Pure functions; no I/O. All vectors are number[] (the Embedder output type).
 * Cosine similarity is used throughout (PREVENT-PI-004 safe — no network).
 */
import type { Vector } from "../embedder.js";
import { cosineSimilarity } from "../embedder.js";

// ─── Topic drift ────────────────────────────────────────────────────────────

/**
 * Compute topic drift as cosine similarity between the current embedding and
 * the centroid of recent embeddings.
 *
 * Returns 0–1: 1 = no drift (current topic matches the recent window exactly),
 * 0 = completely unrelated. Empty recentEmbs returns 1.0 (baseline, no prior).
 *
 * Centroid: element-wise arithmetic mean of recentEmbs.
 * cosineSimilarity normalizes internally; centroid need not be unit-normalized.
 */
export function computeTopicDrift(currentEmb: Vector, recentEmbs: Vector[]): number {
	if (recentEmbs.length === 0) return 1.0;

	const dim = currentEmb.length;
	// Element-wise mean of recent embeddings.
	const centroid = new Array<number>(dim).fill(0);
	for (const emb of recentEmbs) {
		if (emb.length !== dim) continue; // defensive: skip mismatched-dim rows
		for (let i = 0; i < dim; i++) {
			centroid[i] += emb[i];
		}
	}
	for (let i = 0; i < dim; i++) {
		centroid[i] /= recentEmbs.length;
	}

	return cosineSimilarity(currentEmb, centroid);
}

// ─── Error escalation ───────────────────────────────────────────────────────

/**
 * Compute error-rate score from recent error categories.
 *
 * `recentErrorCategories` is a list of error-class strings, or null for
 * non-error turns. Returns 1.0 when the list is empty (no data → assume healthy).
 * The score is 1 - (non-null / total), so an entirely-error list scores 0.
 */
export function computeErrorEscalation(recentErrorCategories: (string | null)[]): number {
	if (recentErrorCategories.length === 0) return 1.0;
	let errors = 0;
	for (const cat of recentErrorCategories) {
		if (cat !== null) errors++;
	}
	return 1 - errors / recentErrorCategories.length;
}

// ─── Prefix instability ─────────────────────────────────────────────────────

/**
 * Compute prefix-stability score using the cache-health formula from
 * perf-handler.ts (tryComputeCacheHealth → stabilityScore).
 *
 * The stability formula from perf-handler.ts:
 *   instability = min(1, prefixBreakCount / (windowMinutes / 5 * 2))
 *   stabilityScore = max(0, 1 - breakSamples.length / maxExpectedBreaks)
 *
 * Here we expose a direct formula:
 *   instability = min(1, prefixBreakCount / (windowMinutes / 5 * 2))
 *   score = 1 - instability
 *        = max(0, 1 - min(1, prefixBreakCount / (windowMinutes / 5 * 2)))
 *
 * Returns 0–1: 1 = perfectly stable (no prefix breaks), 0 = maximally unstable.
 * The window is expressed in minutes so the caller controls the lookback.
 */
export function computePrefixInstability(
	prefixBreakCount: number,
	windowMinutes: number,
): number {
	if (prefixBreakCount <= 0) return 1.0;
	if (windowMinutes <= 0) return 1.0; // defensive: avoid div-by-zero
	const maxExpectedBreaks = (windowMinutes / 5) * 2;
	const instability = Math.min(1, prefixBreakCount / maxExpectedBreaks);
	return Math.max(0, 1 - instability);
}

// ─── Composite drift score ───────────────────────────────────────────────────

/**
 * Weighted composite drift score from three sub-components.
 *
 * Weights are domain-informed:
 *   topic drift (40%)  — the strongest signal of context-switching
 *   error rate (35%)   — errors correlate strongly with confusion
 *   prefix stability (25%) — cache instability is secondary to content quality
 *
 * Returns 0–1: 1 = no drift / perfectly healthy, 0 = severe drift.
 */
export function computeDriftScore(
	topic: number,
	error: number,
	prefix: number,
): number {
	const raw = topic * 0.4 + error * 0.35 + prefix * 0.25;
	return Math.max(0, Math.min(1, raw));
}