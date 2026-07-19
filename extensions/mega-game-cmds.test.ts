/**
 * mega-game-cmds.test.ts — /mega-game command parsing matrix (S30).
 * Uses an isolated state dir + a fake pi harness (mirrors mega-compact.test.ts).
 * Pi runtime is mocked; the src/ helpers under test are pi-agnostic.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { closeStore, getGameState } from "../src/store/sqlite.js";
import { THEME_IDS } from "../src/config/themes.js";

// ESM bootstrap so `require()` works in this .test.ts (mirrors
// mega-compact.test.ts:20-24). Needed for the dynamic `require("./mega-game-cmds.js")`
// that wires the command against a fake pi without binding to the real pi
// module at load time.
const require = createRequire(import.meta.url);

type Cmd = { description?: string; handler: (args: string, ctx: any) => Promise<void> };

type Harness = {
  commands: Record<string, Cmd>;
  notifies: string[];
  ctx: any;
};

function makeHarness(stateDir: string): Harness {
  const commands: Record<string, Cmd> = {};
  const notifies: string[] = [];
  const runtime = { bindRepo: () => {}, currentStateDir: stateDir };
  const ctx = {
    cwd: stateDir,
    ui: { notify: (s: string) => notifies.push(s) },
  };
  const fakePi = {
    registerCommand: (name: string, opts: Cmd) => {
      commands[name] = opts;
    },
  };
  // Import after env is set so stateDir resolves. Dynamic import keeps the
  // test from binding to the real pi module at load time.
  const mod = require("./mega-game-cmds.js") as {
    registerGameCommands: (pi: unknown, runtime: unknown) => void;
  };
  mod.registerGameCommands(fakePi, runtime);
  return { commands, notifies, ctx };
}

describe("/mega-game (S30)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-megagame-"));
    process.env.MEGACOMPACT_STATE_DIR = dir;
  });
  after(() => {
    closeStore(dir);
    delete process.env.MEGACOMPACT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string): Promise<string[]> {
    const h = makeHarness(dir);
    h.notifies.length = 0;
    await h.commands["mega-game"].handler(args, h.ctx);
    return h.notifies;
  }

  it("bare command prints current (default) state", async () => {
    const lines = await run("");
    assert.ok(lines.some((l) => l.includes("game mode: off")));
    assert.ok(lines.some((l) => l.includes("transparent")));
    assert.ok(lines.some((l) => l.includes("tui:")));
  });

  it("on enables game mode and persists", async () => {
    await run("on");
    assert.equal(getGameState().game_mode_on, true);
  });

  it("off disables game mode and persists", async () => {
    await run("on");
    await run("off");
    assert.equal(getGameState().game_mode_on, false);
  });

  it("theme <id> sets a valid theme and persists", async () => {
    await run("theme retro");
    assert.equal(getGameState().theme, "retro");
    await run("theme cyan-neon");
    assert.equal(getGameState().theme, "cyan-neon");
  });

  it("theme <unknown> is rejected with a usage line and does not mutate", async () => {
    await run("theme retro");
    const lines = await run("theme bogus");
    assert.ok(lines.some((l) => l.includes("unknown theme")));
    assert.equal(getGameState().theme, "retro");
  });

  it("theme next cycles to the next theme and wraps", async () => {
    await run(`theme ${THEME_IDS[0]}`);
    await run("theme next");
    assert.equal(getGameState().theme, THEME_IDS[1]);
    // cycle to the end then wrap
    await run(`theme ${THEME_IDS[THEME_IDS.length - 1]!}`);
    await run("theme next");
    assert.equal(getGameState().theme, THEME_IDS[0]);
  });

  it("theme (bare) lists all themes", async () => {
    const lines = await run("theme");
    for (const id of THEME_IDS) {
      assert.ok(lines.some((l) => l.includes(id)), `lists ${id}`);
    }
  });

  it("tui full|minimal sets display mode and persists", async () => {
    await run("tui minimal");
    assert.equal(getGameState().tui_display_mode, "minimal");
    await run("tui full");
    assert.equal(getGameState().tui_display_mode, "full");
  });

  it("tui <bad> prints usage and does not mutate", async () => {
    await run("tui minimal");
    const lines = await run("tui huge");
    assert.ok(lines.some((l) => l.includes("usage")));
    assert.equal(getGameState().tui_display_mode, "minimal");
  });

  it("unknown subcommand prints usage", async () => {
    const lines = await run("bogus");
    assert.ok(lines.some((l) => l.includes("usage")));
  });
});
