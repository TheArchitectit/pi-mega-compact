/**
 * game-achievements.ts — `game_achievements` table accessors (S35).
 *
 * Per-achievement unlock state. One row per of the 9 seeded achievements
 * (seeded idempotently in schema.ts on first open). `unlocked_at` is set
 * once when the condition first holds; hidden achievements stay invisible
 * (no tile, no teaser) until unlocked_at IS NOT NULL (the Opie invariant).
 *
 * PREVENT-PI-004: local SQLite only, zero network.
 * PREVENT-002: all SQL parameterized (? placeholders, no concat of user data).
 * Pi-agnostic: no pi runtime types (mirrors game-scores.ts / game-state.ts).
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";
import { ACHIEVEMENT_DEFS } from "../../game/scoring.js";

/** A game_achievements row. */
export interface AchievementRow {
	id: string;
	title: string;
	description: string;
	hidden: number;
	icon: string | null;
	unlocked_at: number | null;
}

/** The fixed set of valid achievement ids (mirrors ACHIEVEMENT_DEFS). */
const VALID_IDS = new Set(ACHIEVEMENT_DEFS.map((d) => d.id));

/** Intermediate row shape returned by node:sqlite (a Record<string,SQLOutputValue>);
 *  coerced to AchievementRow via toAchievementRow. */
type DbAchRow = {
	id: string;
	title: string;
	description: string;
	hidden: number;
	icon: string | null;
	unlocked_at: number | null;
};

/** Coerce a raw DB row into the typed AchievementRow shape. */
function toAchievementRow(r: DbAchRow): AchievementRow {
	return {
		id: r.id,
		title: r.title,
		description: r.description,
		hidden: r.hidden,
		icon: r.icon,
		unlocked_at: r.unlocked_at,
	};
}

/**
 * List all achievement rows, ordered so hidden+locked (the Opie easter egg
 * before it triggers) sort LAST and visible rows sort by id ASC. Parameterized
 * n/a (no user input reaches this SQL — PREVENT-002 safe).
 */
export function listAchievements(stateDir: string = getStateDir()): AchievementRow[] {
	const db = openStore(stateDir);
	const rows = db
		.prepare(
			`SELECT id, title, description, hidden, icon, unlocked_at
				 FROM game_achievements
				 ORDER BY (hidden=1 AND unlocked_at IS NULL) DESC, id ASC`,
		)
		.all() as DbAchRow[];
	return rows.map(toAchievementRow);
}

/** Get a single achievement row by id (parameterized). Returns null if absent. */
export function getAchievement(stateDir: string = getStateDir(), id: string): AchievementRow | null {
	const db = openStore(stateDir);
	const r = db
		.prepare(
			`SELECT id, title, description, hidden, icon, unlocked_at
				 FROM game_achievements WHERE id = ?`,
		)
		.get(id) as DbAchRow | undefined;
	return r ? toAchievementRow(r) : null;
}

/** True if the achievement has been unlocked (unlocked_at IS NOT NULL). */
export function isUnlocked(stateDir: string = getStateDir(), id: string): boolean {
	const db = openStore(stateDir);
	const row = db
		.prepare(`SELECT unlocked_at FROM game_achievements WHERE id = ?`)
		.get(id) as { unlocked_at: number | null } | undefined;
	return row?.unlocked_at != null;
}

/**
 * Unlock an achievement (set unlocked_at = now) only if it is currently
 * locked (unlocked_at IS NULL). Returns true if this call newly unlocked it,
 * false if it was already unlocked or the id is unknown. Throws on an
 * unknown id (mirrors recordScore's validation discipline).
 */
export function unlockAchievement(stateDir: string = getStateDir(), id: string): boolean {
	if (!VALID_IDS.has(id)) {
		throw new Error(`unlockAchievement: unknown achievement id ${String(id)}`);
	}
	const db = openStore(stateDir);
	const res = db
		.prepare(
			`UPDATE game_achievements SET unlocked_at = ? WHERE id = ? AND unlocked_at IS NULL`,
		)
		.run(Date.now(), id);
	return res.changes > 0;
}

/**
 * Orchestrator: evaluate all achievements against the live leaderboards and
 * persist any newly-unlocked ones. Non-pure (SQLite I/O) but best-effort +
 * non-fatal (G6) — returns [] on any failure. Returns the TITLES (not ids)
 * of the newly-unlocked achievements so callers can fire a one-time toast.
 */
export function evaluateAndUnlockAchievements(stateDir: string = getStateDir()): string[] {
	try {
		const dedupe = leaderboard(stateDir, "dedupe");
		const turns = leaderboard(stateDir, "turns");
		const cache = leaderboard(stateDir, "cache");
		const megaCache = leaderboard(stateDir, "mega_cache");
		const reposCount = leaderboard(stateDir, "repos")[0]?.value ?? 0;
		const alreadyUnlocked = listAchievements(stateDir)
			.filter((r) => r.unlocked_at != null)
			.map((r) => r.id);
		const { newlyUnlocked } = evaluateAchievements(
			{ dedupe, turns, cache, megaCache, reposCount },
			alreadyUnlocked,
		);
		const titles: string[] = [];
		for (const id of newlyUnlocked) {
			const ok = unlockAchievement(stateDir, id);
			if (ok) {
				const def = ACHIEVEMENT_DEFS.find((d) => d.id === id);
				if (def) titles.push(def.title);
			}
		}
		return titles;
	} catch {
		return [];
	}
}

// leaderboard is imported lazily-style at top to avoid a circular init: it lives in
// game-scores.ts (same submodule layer) and is parameterized (PREVENT-002).
import { leaderboard } from "./game-scores.js";
import { evaluateAchievements } from "../../game/scoring.js";
