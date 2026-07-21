/**
 * game-scores.test.ts — S33 game_scores table round-trip + leaderboard ordering.
 * Pi-agnostic. Uses an isolated state dir (never the real user dir — G7).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { closeStore } from "./utils.js";
import {
	recordScore,
	leaderboard,
	METRICS,
	type GameMetric,
} from "./game-scores.js";

describe("game-scores (S33)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "mc-gamescores-"));
		process.env.MEGACOMPACT_STATE_DIR = dir;
	});
	after(() => {
		closeStore(dir);
		delete process.env.MEGACOMPACT_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("records + reads back a cache score with parsed meta", () => {
		recordScore(dir, {
			repo_root: "/repo/a",
			metric: "cache",
			value: 42,
			meta: { hits: 7, lookups: 10 },
		});
		const rows = leaderboard(dir, "cache", { repoRoot: "/repo/a" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].repo_root, "/repo/a");
		assert.equal(rows[0].value, 42);
		assert.deepEqual(rows[0].meta, { hits: 7, lookups: 10 });
	});

	it("cache leaderboard ranks by latest value per repo, descending", () => {
		recordScore(dir, { repo_root: "/repo/a", metric: "cache", value: 10 });
		recordScore(dir, { repo_root: "/repo/a", metric: "cache", value: 99 }); // latest wins
		recordScore(dir, { repo_root: "/repo/b", metric: "cache", value: 50 });
		recordScore(dir, { repo_root: "/repo/c", metric: "cache", value: 75 });
		const rows = leaderboard(dir, "cache"); // all repos, default limit 10
		assert.equal(rows.length, 3);
		assert.deepEqual(
			rows.map((r) => [r.repo_root, r.value]),
			[["/repo/a", 99], ["/repo/c", 75], ["/repo/b", 50]],
		);
		const a = rows.find((r) => r.repo_root === "/repo/a")!;
		assert.equal(a.value, 99); // not the older 10
	});

	it("turns leaderboard uses the latest value per repo", () => {
		recordScore(dir, { repo_root: "/repo/a", metric: "turns", value: 3 });
		recordScore(dir, { repo_root: "/repo/a", metric: "turns", value: 8 });
		const rows = leaderboard(dir, "turns", { repoRoot: "/repo/a" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].value, 8);
	});

	it("dedupe leaderboard sums collapses per repo, descending", () => {
		recordScore(dir, { repo_root: "/repo/a", metric: "dedupe", value: 2 });
		recordScore(dir, { repo_root: "/repo/a", metric: "dedupe", value: 3 });
		recordScore(dir, { repo_root: "/repo/b", metric: "dedupe", value: 10 });
		const rows = leaderboard(dir, "dedupe");
		assert.equal(rows.length, 2);
		assert.deepEqual(
			rows.map((r) => [r.repo_root, r.value]),
			[["/repo/b", 10], ["/repo/a", 5]],
		);
	});

	it("mega_cache leaderboard returns the max trophy per repo", () => {
		recordScore(dir, {
			repo_root: "/repo/a",
			metric: "mega_cache",
			value: 120,
			meta: { peakPct: 120 },
		});
		recordScore(dir, {
			repo_root: "/repo/a",
			metric: "mega_cache",
			value: 150,
			meta: { peakPct: 150 },
		});
		const rows = leaderboard(dir, "mega_cache", { repoRoot: "/repo/a" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].value, 150);
		assert.deepEqual(rows[0].meta, { peakPct: 150 });
	});

	it("repos leaderboard is the derived COUNT(DISTINCT repo_root)", () => {
		recordScore(dir, { repo_root: "/repo/a", metric: "cache", value: 1 });
		recordScore(dir, { repo_root: "/repo/b", metric: "cache", value: 1 });
		recordScore(dir, { repo_root: "/repo/c", metric: "cache", value: 1 });
		const rows = leaderboard(dir, "repos");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].value, 3);
	});

	it("parameterizes repo_root (no SQL injection via repo path)", () => {
		const evil = "x'); DROP TABLE game_scores; --";
		recordScore(dir, { repo_root: evil, metric: "cache", value: 5 });
		const rows = leaderboard(dir, "cache", { repoRoot: evil });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].repo_root, evil);
		// the table is intact: a normal insert still works
		recordScore(dir, { repo_root: "/repo/z", metric: "cache", value: 1 });
		assert.equal(leaderboard(dir, "cache", { repoRoot: "/repo/z" }).length, 1);
	});

	it("rejects an unknown metric", () => {
		const bad = "bogus" as unknown as GameMetric;
		assert.throws(() =>
			recordScore(dir, { repo_root: "/r", metric: bad, value: 1 }),
		);
		assert.throws(() => leaderboard(dir, bad));
	});

	it("METRICS allow-list matches the schema CHECK set", () => {
		assert.deepEqual(
			[...METRICS].sort(),
			["cache", "dedupe", "mega_cache", "repos", "turns"],
		);
	});
});
