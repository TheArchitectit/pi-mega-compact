/**
 * scoring.ts — pure game-mode scoring helpers (S33) + achievements eval (S35).
 *
 * Pi-agnostic: no pi runtime types, no I/O, no dependencies. Every helper is a
 * pure function so it can be unit-tested in isolation and reused by the
 * extension event handlers (src/store stays free of pi types too).
 */
import type { LeaderboardRow } from "../store/sqlite/game-scores.js";

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

// ── S35: achievement definitions + evaluation ─────────────────────────────

/** A single achievement definition (the seed row shape, minus unlocked_at). */
export interface AchievementDef {
	id: string;
	title: string;
	description: string;
	hidden: boolean;
	icon: string;
}

/**
 * The 9 achievements (8 visible + 1 hidden easter egg = Opie's Wild Ride).
 * Seeded idempotently into the `game_achievements` table on first open
 * (schema.ts). Pure, pi-agnostic — no I/O.
 */
export const ACHIEVEMENT_DEFS: readonly AchievementDef[] = [
	{ id: "first_compact", title: "First Compact", description: "Compact a conversation once.", hidden: false, icon: "\u{1F476}" },
	{ id: "compact_streak", title: "Compact Streak", description: "Compact 5 times in one session.", hidden: false, icon: "\u{1F525}" },
	{ id: "turn_veteran", title: "Turn Veteran", description: "Reach 25 turns in a repo.", hidden: false, icon: "\u{1F3C3}" },
	{ id: "level_five", title: "Level 5", description: "Reach player level 5.", hidden: false, icon: "\u{2B50}" },
	{ id: "dedupe_master", title: "Dedupe Master", description: "Collapse 100 chunks total.", hidden: false, icon: "\u{1F5DC}\u{FE0F}" },
	{ id: "repo_explorer", title: "Repo Explorer", description: "Use game mode across 3 repos.", hidden: false, icon: "\u{1F30D}" },
	{ id: "night_owl", title: "Night Owl", description: "Record a score after midnight (00:00–05:00 local).", hidden: false, icon: "\u{1F989}" },
	{ id: "flawless", title: "Flawless", description: "Hit exactly 100% cache with no overshoot.", hidden: false, icon: "\u{1F4AF}" },
	{ id: "opie_wild_ride", title: "Opie's Wild Ride", description: "Push the cache past 100%.", hidden: true, icon: "\u{1F3C6}" },
];

/** Inputs to evaluateAchievements — the S33 leaderboard aggregates. */
export interface AchievementContext {
	dedupe: LeaderboardRow[];
	turns: LeaderboardRow[];
	cache: LeaderboardRow[];
	megaCache: LeaderboardRow[];
	reposCount: number;
}

/** Result of evaluateAchievements. */
export interface AchievementEvalResult {
	unlocked: string[];
	newlyUnlocked: string[];
}

/**
 * Max `compactCount` carried in a dedupe row's `meta` (S33 records
 * `{ compactCount }` on each session_compact). Returns 0 when absent.
 */
export function maxCompactCount(rows: LeaderboardRow[]): number {
	return rows.reduce((m, r) => {
		const meta = r.meta;
		const cm =
			meta && typeof meta === "object" && "compactCount" in meta
				? Number((meta as Record<string, unknown>).compactCount) || 0
				: 0;
		return Math.max(m, cm);
	}, 0);
}

/**
 * Pure evaluation of the 9 achievements against the leaderboard aggregates.
 * `alreadyUnlocked` is the set of ids already persisted (so `newlyUnlocked`
 * excludes them). No I/O, no pi types. Mirrors the S35.9 condition table.
 */
export function evaluateAchievements(
	ctx: AchievementContext,
	alreadyUnlocked: readonly string[],
): AchievementEvalResult {
	const sumBy = (rows: LeaderboardRow[]) =>
		rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
	const maxBy = (rows: LeaderboardRow[]) =>
		rows.reduce((m, r) => Math.max(m, Number(r.value) || 0), 0);

	const dedupeSum = sumBy(ctx.dedupe);
	const maxTurns = maxBy(ctx.turns);
	const maxCache = maxBy(ctx.cache);
	const maxCompact = maxCompactCount(ctx.dedupe);

	// Night owl: any row (across all metrics) recorded between 00:00–05:00 local.
	const allTs = [
		...ctx.dedupe,
		...ctx.turns,
		...ctx.cache,
		...ctx.megaCache,
	];
	const nightOwl = allTs.some((r) => {
		const h = new Date(Number(r.ts) || 0).getHours();
		return h >= 0 && h < 5;
	});

	// Flawless: cache hit 100%+, but NO mega_cache overshoot (>100).
	const megaOvershoot = ctx.megaCache.some((r) => Number(r.value) > 100);

	const conditions: Record<string, boolean> = {
		first_compact: ctx.dedupe.length >= 1,
		compact_streak: maxCompact >= 5,
		turn_veteran: maxTurns >= 25,
		level_five: turnLevel(maxTurns) >= 5,
		dedupe_master: dedupeSum >= 100,
		repo_explorer: ctx.reposCount >= 3,
		night_owl: nightOwl,
		flawless: maxCache >= 100 && !megaOvershoot,
		opie_wild_ride: ctx.megaCache.length >= 1,
	};

	const unlocked = Object.keys(conditions).filter((id) => conditions[id]);
	const newlyUnlocked = unlocked.filter((id) => !alreadyUnlocked.includes(id));
	return { unlocked, newlyUnlocked };
}
