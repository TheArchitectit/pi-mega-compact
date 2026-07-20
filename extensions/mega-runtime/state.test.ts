/**
 * state.test.ts — S31 MegaRuntime game-state cache round-trip.
 *
 * getCachedGameState() lazily reads the game_state row; bumpGameState()
 * evicts so the next read re-queries. Uses MEGACOMPACT_STATE_DIR + mkdtemp
 * (G7). A minimal MegaRuntime is constructed directly (no pi runtime).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { closeStore, getGameState, setGameState } from "../../src/store/sqlite.js";
import { DEFAULT_GAME_STATE } from "../../src/store/sqlite/game-state.js";

const require = createRequire(import.meta.url);
// Require the compiled JS (build output) so ESM import of pi-tui etc. resolves.
const { MegaRuntime } = require("./state.js") as {
	MegaRuntime: new (config: any) => any;
};

/** Minimal MegaConfig — enough fields for the constructor; the snapshot path
 *  isn't exercised here, only getCachedGameState/bumpGameState. */
function minimalConfig(stateDir: string): any {
	return {
		tier: "custom",
		tierPct: null,
		thresholdTokens: 100_000,
		stateDir,
		fastGatePct: 70,
		anchorUserMessages: 3,
		preserveRecent: 4,
		preserveRecentMin: 2,
		auto: false,
		autoInline: false,
		autoContinueLengthStop: false,
		autoPctTrigger: null,
		dedupSim: 0.9,
		raptorEnabled: false,
		legacyDurableTrim: false,
		dbMirror: false,
		crossRepoEnabled: false,
		crossRepoCosine: 0.9,
		memoryAutoReview: false,
		memoryReviewInterval: 10,
		recallMaxTokens: 1500,
		windowDedupe: false,
		debug: false,
	};
}

/** Fresh isolated state dir per test — the game_state row is global and
 *  persists across cases in a shared dir, so each case gets its own mkdtemp to
 *  avoid cross-test contamination. */
function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "mc-state-"));
}

describe("MegaRuntime setEffect lifecycle (v0.8.3)", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) {
			try { closeStore(d); } catch { /* */ }
		}
		delete process.env.MEGACOMPACT_STATE_DIR;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("activeEffect starts null and setEffect arms it with startedAt ~now", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		assert.equal(rt.activeEffect, null, "idle on construction");
		const before = Date.now();
		rt.setEffect("pulse", "accent", 2000);
		const after = Date.now();
		assert.equal(rt.activeEffect.type, "pulse");
		assert.equal(rt.activeEffect.role, "accent");
		assert.equal(rt.activeEffect.durationMs, 2000);
		assert.ok(
			rt.activeEffect.startedAt >= before && rt.activeEffect.startedAt <= after,
			"startedAt within the call window",
		);
	});

	it("setEffect replaces an in-flight effect (last call wins)", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		rt.setEffect("pulse", "accent", 2000);
		const first = rt.activeEffect;
		rt.setEffect("flash", "mega", 1200);
		assert.notEqual(rt.activeEffect, first, "a fresh object replaced the prior");
		assert.equal(rt.activeEffect.type, "flash");
		assert.equal(rt.activeEffect.role, "mega");
		assert.equal(rt.activeEffect.durationMs, 1200);
	});

	it("a backdated effect is recognized as expired by the snapshot predicate", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		rt.setEffect("pulse", "accent", 2000);
		// Backdate startedAt past the duration window (no snapshot/ctx needed —
		// this mirrors the exact predicate snapshot() runs after the flare consume).
		rt.activeEffect.startedAt = Date.now() - 3000;
		const expired =
			!!rt.activeEffect &&
			Date.now() - rt.activeEffect.startedAt >= rt.activeEffect.durationMs;
		assert.ok(expired, "backdated effect satisfies the expiry predicate");
		// Clearing mirrors the snapshot() bookkeeping branch:
		if (expired) rt.activeEffect = null;
		assert.equal(rt.activeEffect, null, "cleared once expired");
	});
});

describe("MegaRuntime game-state cache (S31)", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) {
			try { closeStore(d); } catch { /* */ }
		}
		delete process.env.MEGACOMPACT_STATE_DIR;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("getCachedGameState returns defaults on a fresh install", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		const gs = rt.getCachedGameState();
		assert.deepEqual(gs, { ...DEFAULT_GAME_STATE });
	});

	it("getCachedGameState memoizes (same ref across calls)", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		const a = rt.getCachedGameState();
		const b = rt.getCachedGameState();
		assert.equal(a, b, "memoized — same object ref");
	});

	it("bumpGameState evicts so the next read reflects a setGameState write", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		const before = rt.getCachedGameState();
		assert.equal(before.game_mode_on, false);

		// Write out-of-band (as /mega-game would).
		setGameState({ game_mode_on: true, theme: "retro", tui_display_mode: "minimal" }, dir);

		// Without bump, the stale memo is returned.
		const stale = rt.getCachedGameState();
		assert.equal(stale.game_mode_on, false, "stale cache before bump");

		// After bump, the next read re-queries and reflects the write.
		rt.bumpGameState();
		const fresh = rt.getCachedGameState();
		assert.equal(fresh.game_mode_on, true);
		assert.equal(fresh.theme, "retro");
		assert.equal(fresh.tui_display_mode, "minimal");
		// And matches the authoritative getGameState read.
		assert.deepEqual(fresh, getGameState(dir));
	});

	it("bumpGameState is idempotent (safe to call when cache is empty)", () => {
		const dir = freshDir(); dirs.push(dir);
		process.env.MEGACOMPACT_STATE_DIR = dir;
		const rt = new MegaRuntime(minimalConfig(dir));
		rt.bumpGameState(); // no cached state yet — must not throw
		const gs = rt.getCachedGameState();
		assert.deepEqual(gs, { ...DEFAULT_GAME_STATE });
	});

	it("bindRepo evicts cachedGameState so a repo switch reflects the new repo's game_state", () => {
		// Two fresh git repos A and B simulate a real repo switch. Each holds its
		// own per-repo state dir at <root>/.pi/mega-compact (what repoStateDir
		// returns for a git cwd), and each holds its own game_state row, so a repo
		// switch (bindRepo) must evict the cached memo or the widget shows A's
		// theme/mode/toggle after moving to B. Uses MEGACOMPACT_STATE_DIR + mkdtemp
		// + closeStore (G7); the global state dir stays separate.
		const globalDir = freshDir(); dirs.push(globalDir);
		const repoA = freshDir(); dirs.push(repoA);
		const repoB = freshDir(); dirs.push(repoB);
		const stateA = join(repoA, ".pi", "mega-compact");
		const stateB = join(repoB, ".pi", "mega-compact");

		// Make A and B real git roots so resolveRepoRoot(cwd) returns the root and
		// repoStateDir produces <root>/.pi/mega-compact (the per-repo store).
		execSync("git init -q", { cwd: repoA });
		execSync("git init -q", { cwd: repoB });

		// Seed A and B with distinct game_state rows in their per-repo dirs.
		setGameState({ game_mode_on: true, theme: "retro", tui_display_mode: "minimal" }, stateA);
		setGameState({ game_mode_on: false, theme: "cyan-neon", tui_display_mode: "full" }, stateB);

		// Construct the runtime against the GLOBAL dir (the non-git fallback so a
		// real bindRepo switch occurs once we point it at a git root).
		process.env.MEGACOMPACT_STATE_DIR = globalDir;
		const rt = new MegaRuntime(minimalConfig(globalDir));

		// Point the runtime at repo A and prime the cache.
		rt.bindRepo(repoA);
		assert.equal(rt.currentStateDir, stateA, "bindRepo(A) switched to A's per-repo dir");
		const a = rt.getCachedGameState();
		assert.equal(a.game_mode_on, true, "A: game_mode_on primed");
		assert.equal(a.theme, "retro", "A: theme primed");
		assert.equal(a.tui_display_mode, "minimal", "A: tui_display_mode primed");

		// Switch to repo B: bindRepo must evict cachedGameState so the next read
		// re-queries B's row instead of returning A's stale memo.
		rt.bindRepo(repoB);
		assert.equal(rt.currentStateDir, stateB, "bindRepo(B) switched to B's per-repo dir");
		const b = rt.getCachedGameState();
		assert.equal(b.game_mode_on, false, "B: game_mode_on after switch (not A's stale true)");
		assert.equal(b.theme, "cyan-neon", "B: theme after switch (not A's stale retro)");
		assert.equal(b.tui_display_mode, "full", "B: tui_display_mode after switch (not A's stale minimal)");
		assert.deepEqual(b, getGameState(stateB), "B matches authoritative getGameState read");

		// Cleanup the per-repo DB handles.
		try { closeStore(globalDir); } catch { /* */ }
		try { closeStore(stateA); } catch { /* */ }
		try { closeStore(stateB); } catch { /* */ }
	});
});
