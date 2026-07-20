/**
 * dashboard-server.test.ts — S32 game-state API + settings strip tests.
 *
 * GET/PUT /api/game-state round-trips the game_state SQLite row through the
 * real server subprocess (spawn + waitFor + fetch), and the HTML template
 * carries the data-theme attribute + settings strip + theme CSS-var blocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dashboardHtml } from "./dashboard-server/html.js";
import { setGameState, getGameState } from "../src/store/sqlite.js";

const SERVER_ENTRY = new URL("./dashboard-server.js", import.meta.url).pathname;

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withServer<T>(
  port: string,
  dir: string,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  process.env.MEGACOMPACT_DASHBOARD_PORT = port;
  const child = spawn(process.execPath, [SERVER_ENTRY, dir], { stdio: "ignore" });
  try {
    await waitFor(async () => {
      try {
        const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
        const res = await fetch(`http://localhost:${raw.port}/api/version`);
        return res.ok;
      } catch {
        return false;
      }
    });
    const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
    return await fn(raw.port);
  } finally {
    child.kill("SIGTERM");
    delete process.env.MEGACOMPACT_DASHBOARD_PORT;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("S32 /api/game-state", () => {
  test("GET returns the current game_state row (seeded via setGameState)", async () => {
    const dir = freshDir("dash-gs-get-");
    setGameState({ game_mode_on: true, theme: "retro", tui_display_mode: "minimal" }, dir);
    await withServer("19330", dir, async (port) => {
      const gs = (await fetch(`http://localhost:${port}/api/game-state`).then((r) => r.json())) as {
        game_mode_on: boolean; theme: string; tui_display_mode: string;
      };
      assert.equal(gs.game_mode_on, true);
      assert.equal(gs.theme, "retro");
      assert.equal(gs.tui_display_mode, "minimal");
    });
  });

  test("PUT {theme:'retro'} -> 200 and getGameState(dir).theme === 'retro'", async () => {
    const dir = freshDir("dash-gs-theme-");
    await withServer("19331", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "retro" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { theme: string };
      assert.equal(body.theme, "retro");
      // And the authoritative DB read reflects the write.
      assert.equal(getGameState(dir).theme, "retro");
    });
  });

  test("PUT invalid theme 'bogus' -> 400 and row unchanged", async () => {
    const dir = freshDir("dash-gs-invalid-");
    setGameState({ theme: "orange-bold" }, dir);
    const before = getGameState(dir).theme;
    await withServer("19332", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "bogus" }),
      });
      assert.equal(res.status, 400);
    });
    assert.equal(getGameState(dir).theme, before, "row unchanged after invalid PUT");
  });

  test("PUT body 'null' (valid-but-non-object JSON) -> 400, server stays up (audit P1)", async () => {
    const dir = freshDir("dash-gs-nullobj-");
    setGameState({ theme: "amber-mono" }, dir);
    const before = getGameState(dir).theme;
    await withServer("19335", dir, async (port) => {
      // A valid-JSON-but-non-object body must NOT crash the detached server
      // (audit P1: unhandled TypeError on patch.game_mode_on deref).
      const res = await fetch(`http://localhost:${port}/api/game-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(null),
      });
      assert.equal(res.status, 400, "non-object JSON -> 400, not a crash");
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid_patch_object");
      // Server must still be up — a follow-up GET must succeed.
      const follow = await fetch(`http://localhost:${port}/api/game-state`);
      assert.equal(follow.status, 200, "server survived the non-object PUT");
    });
    assert.equal(getGameState(dir).theme, before, "row unchanged after non-object PUT");
  });

  test("PUT body '[]' (array) -> 400, server stays up", async () => {
    const dir = freshDir("dash-gs-arr-");
    await withServer("19336", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });
      assert.equal(res.status, 400);
      const follow = await fetch(`http://localhost:${port}/api/game-state`);
      assert.equal(follow.status, 200, "server survived the array PUT");
    });
  });

  test("PUT {tui_display_mode:'minimal'} round-trips", async () => {
    const dir = freshDir("dash-gs-tui-");
    await withServer("19333", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tui_display_mode: "minimal" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tui_display_mode: string };
      assert.equal(body.tui_display_mode, "minimal");
      assert.equal(getGameState(dir).tui_display_mode, "minimal");
    });
  });

  test("PUT {game_mode_on:true} round-trips", async () => {
    const dir = freshDir("dash-gs-mode-");
    await withServer("19334", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game_mode_on: true }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { game_mode_on: boolean };
      assert.equal(body.game_mode_on, true);
      assert.equal(getGameState(dir).game_mode_on, true);
    });
  });
});

describe("S32 dashboard HTML skin", () => {
  test("carries data-theme on <html> + settings strip + theme CSS-var blocks", () => {
    const html = dashboardHtml("custom");
    // default transparent theme attribute on <html>
    assert.match(html, /<html lang="en" data-theme="transparent">/);
    // settings strip with the three controls
    assert.match(html, /<div class="settings-strip">/);
    assert.match(html, /id="set-game-mode"/);
    assert.match(html, /id="set-theme"/);
    assert.match(html, /id="set-tui-mode"/);
    // all 6 theme ids appear as :root[data-theme="<id>"] override blocks
    for (const id of ["transparent", "retro", "orange-bold", "cyan-neon", "amber-mono", "grayscale"]) {
      assert.ok(html.includes(`:root[data-theme="${id}"]{`), `${id} data-theme block present`);
    }
    // core CSS vars defined in the base :root
    assert.match(html, /--bg: #0d1117;/);
    assert.match(html, /--fg: #c9d1d9;/);
    assert.match(html, /--accent: #3fb950;/);
    assert.match(html, /--mega: #f0883e;/);
    // body uses the themed var (not a hardcoded hex)
    assert.match(html, /body\s*\{[^}]*background: var\(--bg\)/);
  });
});
