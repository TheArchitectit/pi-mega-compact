/**
 * game-scores.ts — `game_scores` table accessors (S33).
 *
 * Per-repo leaderboard metrics for game mode. One row per recorded event
 * (turn_end / session_compact); leaderboard() derives rankings (latest / max /
 * SUM / COUNT DISTINCT) per repo_root. 'repos' is derived (never recorded).
 *
 * PREVENT-PI-004: local SQLite only, zero network.
 * PREVENT-002: all SQL parameterized (? placeholders, no string concat of user
 *   data). The metric is validated against a fixed allow-list before use; the
 *   only interpolated fragments are code-controlled constants (the aggregate
 *   selector + the optional repo_root filter clause), never external input.
 * Pi-agnostic: no pi runtime types (mirrors game-state.ts / meta.ts).
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";
import type { SQLInputValue } from "node:sqlite";
import { GameMetric, METRICS } from "../../game/scoring.js";

// Process-local monotonic sequence appended into the low 3 digits of `ts` so
// back-to-back inserts within the same millisecond get distinct PK values
// (Date.now()*1000 + seq%1000). Production turns are >1ms apart, so seq is
// almost always 0; this only disambiguates the burst case. Without it,
// OR REPLACE would drop the earlier same-ms row and break the dedupe SUM.
let scoreSeq = 0;
function nextTs(): number {
	return Date.now() * 1000 + (scoreSeq++ % 1000);
}

export type { GameMetric } from "../../game/scoring.js";
export { METRICS } from "../../game/scoring.js";

/** A single recorded game-score event (as stored). */
export interface ScoreRow {
	repo_root: string;
	metric: GameMetric;
	ts: number;
	value: number;
	meta?: unknown;
}

/** A leaderboard row returned by leaderboard(). */
export interface LeaderboardRow {
	repo_root: string;
	value: number;
	ts: number;
	meta: unknown;
}

/** Options for leaderboard(): optional repo filter + result limit. */
export interface LeaderboardOpts {
	repoRoot?: string;
	limit?: number;
}

/**
 * Record one game-score event. `ts` is set to Date.now() by the store. SQL is
 * fully parameterized (PREVENT-002); the metric is validated against the fixed
 * allow-list. Pi-agnostic. Never throws except on a genuinely unknown metric.
 */
export function recordScore(
	stateDir: string = getStateDir(),
	args: { repo_root: string; metric: GameMetric; value: number; meta?: unknown },
): void {
	if (!METRICS.includes(args.metric)) {
		throw new Error(`recordScore: unknown game metric ${String(args.metric)}`);
	}
	const db = openStore(stateDir);
	db.prepare(
		`INSERT INTO game_scores (repo_root, metric, ts, value, meta)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(
		args.repo_root,
		args.metric,
		nextTs(),
		args.value,
		args.meta != null ? JSON.stringify(args.meta) : null,
	);
}

/**
 * Read the leaderboard for a metric:
 *   - cache/turns: latest value per repo_root, sorted desc by value.
 *   - mega_cache: the max value (trophy) per repo_root, sorted desc.
 *   - dedupe: SUM(value) per repo_root (cumulative collapses), sorted desc.
 *   - repos: COUNT(DISTINCT repo_root) — derived; returns a single synthesized
 *     row (repo_root '*') with the distinct-repo count as `value`.
 * The metric is validated against the allow-list. Pi-agnostic.
 */
export function leaderboard(
	stateDir: string = getStateDir(),
	metric: GameMetric,
	opts: LeaderboardOpts = {},
): LeaderboardRow[] {
	if (!METRICS.includes(metric)) {
		throw new Error(`leaderboard: unknown game metric ${String(metric)}`);
	}
	const db = openStore(stateDir);
	const limit = Math.max(1, opts.limit ?? 10);
	// Code-controlled filter clauses (never external input) — safe under PREVENT-002.
	// Two variants: the dedupe query is single-table (unqualified repo_root);
	// the cache/turns/mega_cache query self-JOINs (must qualify as g.repo_root).
	const repoFilterDedupe = opts.repoRoot != null ? " AND repo_root = ?" : "";
	const repoFilter = opts.repoRoot != null ? " AND g.repo_root = ?" : "";
	const repoParam: SQLInputValue[] = opts.repoRoot != null ? [opts.repoRoot] : [];

	if (metric === "repos") {
		const row = db
			.prepare(`SELECT COUNT(DISTINCT repo_root) AS value FROM game_scores`)
			.get() as { value: number };
		return [{ repo_root: "*", value: row.value, ts: 0, meta: null }];
	}

	if (metric === "dedupe") {
		const sql = `SELECT repo_root, SUM(value) AS value, MAX(ts) AS ts, NULL AS meta
					 FROM game_scores
					 WHERE metric = ?${repoFilterDedupe}
					 GROUP BY repo_root
					 ORDER BY value DESC
					 LIMIT ?`;
		const rows = db.prepare(sql).all(metric, ...repoParam, limit) as Array<{
			repo_root: string;
			value: number;
			ts: number;
			meta: string | null;
		}>;
		return rows.map(toLeaderboardRow);
	}

	// cache / turns / mega_cache: pick the qualifying row per repo_root (latest
	// ts, or max value for mega_cache), then rank by value desc. The interpolated
	// `key`/`col` fragments are derived from the validated metric — code constants,
	// not user data (PREVENT-002 safe).
	const key = metric === "mega_cache" ? "MAX(value)" : "MAX(ts)";
	const col = metric === "mega_cache" ? "value" : "ts";
	const sql = `SELECT g.repo_root, g.value AS value, g.ts AS ts, g.meta AS meta
					 FROM game_scores g
					 JOIN (SELECT repo_root, ${key} AS k
							 FROM game_scores WHERE metric = ? GROUP BY repo_root) m
						ON m.repo_root = g.repo_root AND m.k = g.${col}
					 WHERE g.metric = ?${repoFilter}
					 ORDER BY g.value DESC
					 LIMIT ?`;
	const rows = db
		.prepare(sql)
		.all(metric, metric, ...repoParam, limit) as Array<{
		repo_root: string;
		value: number;
		ts: number;
		meta: string | null;
	}>;
	return rows.map(toLeaderboardRow);
}

/** Helper: coerce a raw row (meta as JSON text) into a LeaderboardRow. */
function toLeaderboardRow(r: {
	repo_root: string;
	value: number;
	ts: number;
	meta: string | null;
}): LeaderboardRow {
	return {
		repo_root: r.repo_root,
		value: r.value,
		ts: r.ts,
		meta: r.meta != null ? JSON.parse(r.meta) : null,
	};
}
