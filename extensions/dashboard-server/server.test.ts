/**
 * server.test.ts — S34 /api/game-scores endpoint (GET leaderboard, metric
 * validation, method + limit handling). Mirrors the S32 /api/game-state
 * spawn-and-fetch harness.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { recordScore } from "../../src/store/sqlite.js";

const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;

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

describe("S34 /api/game-scores", () => {
  test("GET ?metric=cache returns recorded rows as JSON array", async () => {
    const dir = freshDir("dash-gs-cache-");
    recordScore(dir, { repo_root: "/repo/a", metric: "cache", value: 42 });
    await withServer("19430", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-scores?metric=cache`);
      assert.equal(res.status, 200);
      const rows = (await res.json()) as Array<{ repo_root: string; value: number; ts: number }>;
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].repo_root, "/repo/a");
      assert.equal(rows[0].value, 42);
      assert.ok(typeof rows[0].ts === "number");
    });
  });

  test("unknown metric -> 400", async () => {
    const dir = freshDir("dash-gs-bad-");
    await withServer("19431", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-scores?metric=bogus`);
      assert.equal(res.status, 400);
    });
  });

  test("non-GET (POST) -> 405", async () => {
    const dir = freshDir("dash-gs-meth-");
    await withServer("19432", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/game-scores`, { method: "POST" });
      assert.equal(res.status, 405);
    });
  });

  test("limit clamp: 3 rows -> default 10 returns 3, limit=2 caps to 2, limit<=0 clamps to >=1", async () => {
    const dir = freshDir("dash-gs-lim-");
    recordScore(dir, { repo_root: "/repo/a", metric: "cache", value: 1 });
    recordScore(dir, { repo_root: "/repo/b", metric: "cache", value: 2 });
    recordScore(dir, { repo_root: "/repo/c", metric: "cache", value: 3 });
    await withServer("19433", dir, async (port) => {
      const all = (await fetch(`http://localhost:${port}/api/game-scores?metric=cache`).then((r) => r.json())) as unknown[];
      assert.equal(all.length, 3);
      const capped = (await fetch(`http://localhost:${port}/api/game-scores?metric=cache&limit=2`).then((r) => r.json())) as unknown[];
      assert.equal(capped.length, 2);
      const zero = (await fetch(`http://localhost:${port}/api/game-scores?metric=cache&limit=0`).then((r) => r.json())) as unknown[];
      assert.ok(zero.length >= 1, "limit<=0 clamps to >=1 row");
    });
  });
});
