/**
 * scoring.test.ts — S33 pure scoring helpers. Pi-agnostic, no I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { turnLevel, isMegaCache, cacheScore, evaluateAchievements, maxCompactCount, ACHIEVEMENT_DEFS } from "./scoring.js";
import type { LeaderboardRow } from "../store/sqlite/game-scores.js";

describe("scoring (S33)", () => {
	it("turnLevel: floor(log2(n+1))+1 sequence", () => {
		assert.equal(turnLevel(0), 1);
		assert.equal(turnLevel(1), 2);
		assert.equal(turnLevel(2), 2);
		assert.equal(turnLevel(3), 3);
		assert.equal(turnLevel(4), 3);
		assert.equal(turnLevel(7), 4);
		assert.equal(turnLevel(15), 5);
		// defensive: non-finite / negative inputs collapse to level 1
		assert.equal(turnLevel(-1), 1);
		assert.equal(turnLevel(NaN), 1);
	});

	it("isMegaCache: 100% is the boundary", () => {
		assert.equal(isMegaCache(99.9), false);
		assert.equal(isMegaCache(100), true);
		assert.equal(isMegaCache(150), true);
		assert.equal(isMegaCache(0), false);
		assert.equal(isMegaCache(NaN), false);
	});

	it("cacheScore: 0 lookups -> 0 (not NaN), else hits/lookups*100", () => {
		assert.equal(cacheScore(0, 0), 0);
		assert.equal(cacheScore(7, 10), 70);
		assert.equal(cacheScore(0, 5), 0);
		assert.equal(cacheScore(10, 10), 100);
		// non-finite inputs are guarded (no NaN leaks)
		assert.equal(cacheScore(1, NaN), 0);
		assert.equal(cacheScore(NaN, 5), 0);
	});
});

function achRow(value: number, opts: { ts?: number; meta?: unknown } = {}): LeaderboardRow {
	return { repo_root: "/repo/a", value, ts: opts.ts ?? 1_700_000_000_000, meta: opts.meta ?? null };
}

describe("evaluateAchievements (S35)", () => {
	const empty = { dedupe: [] as LeaderboardRow[], turns: [] as LeaderboardRow[], cache: [] as LeaderboardRow[], megaCache: [] as LeaderboardRow[], reposCount: 0 };
	it("ACHIEVEMENT_DEFS: 9 achievements, exactly 1 hidden", () => {
		assert.equal(ACHIEVEMENT_DEFS.length, 9);
		assert.equal(ACHIEVEMENT_DEFS.filter((d) => d.hidden).length, 1);
	});
	it("first_compact: >=1 dedupe row", () => {
		const r = evaluateAchievements({ ...empty, dedupe: [achRow(1)] }, []);
		assert.ok(r.unlocked.includes("first_compact"));
		assert.ok(r.newlyUnlocked.includes("first_compact"));
	});
	it("compact_streak: max meta.compactCount >= 5", () => {
		const r = evaluateAchievements({ ...empty, dedupe: [achRow(1, { meta: { compactCount: 5 } })] }, []);
		assert.ok(r.unlocked.includes("compact_streak"));
	});
	it("turn_veteran: max turns >= 25", () => {
		const r = evaluateAchievements({ ...empty, turns: [achRow(25)] }, []);
		assert.ok(r.unlocked.includes("turn_veteran"));
	});
	it("level_five: turnLevel(maxTurns) >= 5 (15 turns)", () => {
		const r = evaluateAchievements({ ...empty, turns: [achRow(15)] }, []);
		assert.ok(r.unlocked.includes("level_five"));
	});
	it("dedupe_master: sum dedupe >= 100", () => {
		const r = evaluateAchievements({ ...empty, dedupe: [achRow(60), achRow(40)] }, []);
		assert.ok(r.unlocked.includes("dedupe_master"));
	});
	it("repo_explorer: reposCount >= 3", () => {
		const r = evaluateAchievements({ ...empty, reposCount: 3 }, []);
		assert.ok(r.unlocked.includes("repo_explorer"));
	});
	it("night_owl: a row whose local hour is in [0,5)", () => {
		const d = new Date(); d.setHours(2, 0, 0, 0);
		const r = evaluateAchievements({ ...empty, cache: [achRow(50, { ts: d.getTime() })] }, []);
		assert.ok(r.unlocked.includes("night_owl"));
	});
	it("flawless: maxCache >= 100 AND no mega_cache overshoot", () => {
		const r = evaluateAchievements({ ...empty, cache: [achRow(100)], megaCache: [] }, []);
		assert.ok(r.unlocked.includes("flawless"));
	});
	it("flawless NOT when a mega_cache overshoot row (>100) exists", () => {
		const r = evaluateAchievements({ ...empty, cache: [achRow(100)], megaCache: [achRow(101)] }, []);
		assert.ok(!r.unlocked.includes("flawless"));
	});
	it("opie_wild_ride: any mega_cache trophy row exists", () => {
		const r = evaluateAchievements({ ...empty, megaCache: [achRow(100)] }, []);
		assert.ok(r.unlocked.includes("opie_wild_ride"));
	});
	it("newlyUnlocked excludes ids already unlocked", () => {
		const r = evaluateAchievements({ ...empty, dedupe: [achRow(1)] }, ["first_compact"]);
		assert.ok(r.unlocked.includes("first_compact"));
		assert.ok(!r.newlyUnlocked.includes("first_compact"));
	});
	it("maxCompactCount: 0 when meta absent, else the max", () => {
		assert.equal(maxCompactCount([achRow(1)]), 0);
		assert.equal(maxCompactCount([achRow(1, { meta: { compactCount: 7 } })]), 7);
	});
});
