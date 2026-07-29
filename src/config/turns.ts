/**
 * config/turns.ts — SINGLE SOURCE OF TRUTH for the S49 turn-store flags.
 *
 * Feature-flag semantics (docs/specs/s49-turn-db-foundation.md):
 * - TURNS_DB_ENABLED defaults ON (isolated turns.db). OFF = byte-identical S48
 *   behavior (turn helpers use the main sqlite.db). Opt-out, not opt-in.
 * - All values read from MEGACOMPACT_* env at load, with the defaults below as
 *   fallback. Booleans/numbers only — no calibration.
 *
 * PREVENT-PI-004: pure config, no network.
 */

function envBool(name: string, def: boolean): boolean {
	const v = process.env[name];
	if (v === undefined) return def;
	return v === "true" || v === "1";
}

function envNum(name: string, def: number): number {
	const v = process.env[name];
	if (v === undefined) return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}

export interface TurnsConfigShape {
	/** Isolated turns.db store enabled (default true). OFF = legacy main-db path. */
	TURNS_DB_ENABLED: boolean;
	/** Per-turn provenance retention window, days (default 30). */
	TURNS_RETENTION_DAYS: number;
	/** Minimum turns always kept per conversation during prune (default 5). */
	TURNS_KEEP_MIN_PER_CONVERSATION: number;
	/** S51: auto-categorizing wiki (k-means + TF-IDF over real embeddings). Default ON. */
	AUTO_WIKI_ENABLED: boolean;
	/** S51: [minK, maxK] cluster-count search space (default 3..15). */
	WIKI_K_MIN: number;
	WIKI_K_MAX: number;
	/** S51: how many TF-IDF terms form a topic label (default 5). */
	WIKI_LABEL_TOP_TERMS: number;
	/** S51: rebuild the topic model every Nth compaction (default 10). */
	WIKI_REBUILD_EVERY_N_COMPACTS: number;
}

function envKRange(defMin: number, defMax: number): [number, number] {
	const v = process.env.MEGACOMPACT_WIKI_K_RANGE;
	if (v) {
		const parts = v.split(",").map((s) => Number(s.trim()));
		if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n >= 1)) {
			return [Math.floor(parts[0]), Math.floor(parts[1])];
		}
	}
	return [defMin, defMax];
}

export function loadTurnsConfig(): TurnsConfigShape {
	const [kMin, kMax] = envKRange(3, 15);
	return {
		TURNS_DB_ENABLED: envBool("MEGACOMPACT_TURNS_DB", true),
		TURNS_RETENTION_DAYS: envNum("MEGACOMPACT_TURNS_RETENTION_DAYS", 30),
		TURNS_KEEP_MIN_PER_CONVERSATION: envNum("MEGACOMPACT_TURNS_KEEP_MIN", 5),
		AUTO_WIKI_ENABLED: envBool("MEGACOMPACT_AUTO_WIKI", true),
		WIKI_K_MIN: kMin,
		WIKI_K_MAX: kMax,
		WIKI_LABEL_TOP_TERMS: envNum("MEGACOMPACT_WIKI_LABEL_TOP_TERMS", 5),
		WIKI_REBUILD_EVERY_N_COMPACTS: envNum("MEGACOMPACT_WIKI_REBUILD_EVERY", 10),
	};
}

export const TurnsConfig: TurnsConfigShape = loadTurnsConfig();
