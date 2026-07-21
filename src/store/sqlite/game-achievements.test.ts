/**
 * game-achievements.test.ts — S35 game_achievements table + accessors.
 * Pi-agnostic. Uses an isolated state dir (never the real user dir — G7).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { closeStore } from "./utils.js";
import {
	listAchievements,
	getAchievement,
	isUnlocked,
	unlockAchievement,
} from "./game-achievements.js";

describe("game-achievements (S35)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "mc-ach-"));
		process.env.MEGACOMPACT_STATE_DIR = dir;
	});
	after(() => {
		closeStore(dir);
		delete process.env.MEGACOMPACT_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("seeds exactly 9 rows on first open (idempotent)", () => {
		const rows = listAchievements(dir);
		assert.equal(rows.length, 9);
		// re-open: seeding is idempotent, still 9, unlocked_at still null
		const again = listAchievements(dir);
		assert.equal(again.length, 9);
		assert.ok(again.every((r) => r.unlocked_at == null));
	});

	it("ordering: visible rows sorted by id asc; opie hidden+locked present", () => {
		const rows = listAchievements(dir);
		const opie = rows.find((r) => r.id === "opie_wild_ride");
		assert.ok(opie, "opie_wild_ride present");
		assert.equal(opie!.hidden, 1);
		assert.equal(opie!.unlocked_at, null);
		const visible = rows.filter((r) => !(r.hidden === 1 && r.unlocked_at == null));
		const ids = visible.map((r) => r.id);
		const sorted = [...ids].sort();
		assert.deepEqual(ids, sorted, "visible rows ordered by id asc");
	});

	it("getAchievement returns a row by id, null for unknown", () => {
		const r = getAchievement(dir, "first_compact");
		assert.ok(r);
		assert.equal(r!.title, "First Compact");
		assert.equal(getAchievement(dir, "nope"), null);
	});

	it("isUnlocked false before unlock, true after", () => {
		assert.equal(isUnlocked(dir, "first_compact"), false);
		assert.equal(unlockAchievement(dir, "first_compact"), true);
		assert.equal(isUnlocked(dir, "first_compact"), true);
	});

	it("unlock is idempotent (second call false, unlocked_at unchanged)", () => {
		assert.equal(unlockAchievement(dir, "turn_veteran"), true);
		const t0 = getAchievement(dir, "turn_veteran")!.unlocked_at;
		assert.equal(unlockAchievement(dir, "turn_veteran"), false);
		assert.equal(getAchievement(dir, "turn_veteran")!.unlocked_at, t0);
	});

	it("unlockAchievement throws on unknown id", () => {
		assert.throws(() => unlockAchievement(dir, "bogus"));
	});

	it("parameterizes id (no SQL injection via crafted id)", () => {
		// The accessors bind id as a param; a hostile id is a literal lookup, never executed.
		assert.equal(getAchievement(dir, "x'); DROP TABLE game_achievements; --"), null);
		assert.throws(() => unlockAchievement(dir, "x'); DROP TABLE game_achievements; --"));
	});
});
