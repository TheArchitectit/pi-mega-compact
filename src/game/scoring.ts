/**
 * scoring.ts — pure game-mode scoring helpers (S33).
 *
 * Pi-agnostic: no pi runtime types, no I/O, no dependencies. Every helper is a
 * pure function so it can be unit-tested in isolation and reused by the
 * extension event handlers (src/store stays free of pi types too).
 */

/** The set of leaderboard metrics tracked in the `game_scores` table. */
export type GameMetric = "cache" | "dedupe" | "turns" | "repos" | "mega_cache";

/** Canonical allow-list of game metrics (mirrors the schema CHECK constraint). */
export const METRICS: readonly GameMetric[] = [
	"cache",
	"dedupe",
	"turns",
	"repos",
	"mega_cache",
];

/**
 * Player level as a function of completed turns.
 * Sequence: n=0→1, 1→2, 2→2, 3→3, 4→3, 7→4, 15→5, ...
 * i.e. floor(log2(n+1)) + 1 (one level per doubling of turns). Defensive: any
 * non-finite / negative input collapses to level 1 (never throws, never NaN).
 */
export function turnLevel(n: number): number {
	if (!Number.isFinite(n) || n < 0) return 1;
	return Math.floor(Math.log2(n + 1)) + 1;
}

/**
 * MEGA CACHE trigger test: the cache hit-rate (real ratio, may exceed 100%)
 * has crossed the 100% threshold. Used to award the mega_cache trophy + arm
 * the widget flare (the oopsie gag).
 */
export function isMegaCache(pct: number): boolean {
	return Number.isFinite(pct) && pct >= 100;
}

/**
 * Cache-hit percentage (0..100+). Returns 0 when there are no lookups so the
 * ratio can never be NaN / Infinity (QA3). Safe against non-finite inputs.
 */
export function cacheScore(hits: number, lookups: number): number {
	if (!Number.isFinite(hits) || !Number.isFinite(lookups)) return 0;
	return lookups > 0 ? (hits / lookups) * 100 : 0;
}
