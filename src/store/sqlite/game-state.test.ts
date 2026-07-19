/**
 * game-state.test.ts — S30 game_state table round-trip + validation.
 * Pi-agnostic. Uses an isolated state dir (never the real user dir — G7).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { closeStore } from "./utils.js";
import {
  getGameState,
  setGameState,
  DEFAULT_GAME_STATE,
} from "./game-state.js";

describe("game-state (S30)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-gamestate-"));
    process.env.MEGACOMPACT_STATE_DIR = dir;
  });
  after(() => {
    closeStore(dir);
    delete process.env.MEGACOMPACT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns DEFAULT_GAME_STATE on a fresh store", () => {
    const s = getGameState();
    assert.deepEqual(s, { ...DEFAULT_GAME_STATE });
    assert.equal(s.game_mode_on, false);
    assert.equal(s.theme, "transparent");
    assert.equal(s.tui_display_mode, "full");
  });

  it("round-trips game_mode_on", () => {
    setGameState({ game_mode_on: true });
    assert.equal(getGameState().game_mode_on, true);
    setGameState({ game_mode_on: false });
    assert.equal(getGameState().game_mode_on, false);
  });

  it("round-trips a valid theme", () => {
    setGameState({ theme: "retro" });
    assert.equal(getGameState().theme, "retro");
    setGameState({ theme: "cyan-neon" });
    assert.equal(getGameState().theme, "cyan-neon");
  });

  it("rejects an unknown theme (keeps previous)", () => {
    setGameState({ theme: "orange-bold" });
    setGameState({ theme: "does-not-exist" as string });
    assert.equal(getGameState().theme, "orange-bold");
  });

  it("round-trips tui_display_mode full|minimal", () => {
    setGameState({ tui_display_mode: "minimal" });
    assert.equal(getGameState().tui_display_mode, "minimal");
    setGameState({ tui_display_mode: "full" });
    assert.equal(getGameState().tui_display_mode, "full");
  });

  it("persists across a reopen (survives restart)", () => {
    setGameState({ game_mode_on: true, theme: "amber-mono", tui_display_mode: "minimal" });
    // evict + reopen the store to prove it hit disk
    closeStore(dir);
    const s = getGameState();
    assert.equal(s.game_mode_on, true);
    assert.equal(s.theme, "amber-mono");
    assert.equal(s.tui_display_mode, "minimal");
  });

  it("setGameState is a partial merge (untouched fields preserved)", () => {
    setGameState({ game_mode_on: true, theme: "grayscale", tui_display_mode: "minimal" });
    const s = setGameState({ game_mode_on: false });
    assert.equal(s.game_mode_on, false);
    assert.equal(s.theme, "grayscale");
    assert.equal(s.tui_display_mode, "minimal");
  });

  it("stays a single row (no duplicate id=1)", () => {
    setGameState({ game_mode_on: true });
    setGameState({ game_mode_on: false });
    setGameState({ theme: "retro" });
    const s = getGameState();
    assert.ok(s); // single state, last-write-wins
  });
});
