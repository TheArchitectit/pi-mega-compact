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
});
