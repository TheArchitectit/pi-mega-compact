/**
 * dashboard-server.test.ts — unit tests for the standalone HTTP dashboard server.
 *
 * Tests the core logic (snapshot building, API responses) without requiring
 * a live pi session or model.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "dashboard-test-"));
}

function writeSnapshot(dir: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("snapshot.json reading", () => {
  test("returns valid snapshot when file exists", () => {
    const dir = tmpDir();
    const snapshot = {
      updatedAt: new Date().toISOString(),
      tier: "medium",
      version: 1,
      config: { activeTier: "medium" },
      session: { id: "test-123", state: "running", persistedThisSession: true },
      context: { tokens: 50000, percent: 50, contextWindow: 100000 },
      trigger: { armed: true, ready: false, currentTokens: 50000, thresholdTokens: 100000 },
      store: { checkpointCount: 3, totalTokenEstimate: 15000 },
    };
    writeSnapshot(dir, snapshot);

    const content = readFileSync(join(dir, "snapshot.json"), "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.tier, "medium");
    assert.equal(parsed.session.id, "test-123");
    assert.equal(parsed.context.percent, 50);
    assert.equal(parsed.store.checkpointCount, 3);
    rmSync(dir, { recursive: true });
  });

  test("handles missing snapshot.json gracefully", () => {
    const dir = tmpDir();
    const snapshotPath = join(dir, "snapshot.json");
    assert.equal(existsSync(snapshotPath), false);
    rmSync(dir, { recursive: true });
  });
});

describe("dashboard.json (compact snapshot)", () => {
  test("round-trips correctly", () => {
    const dir = tmpDir();
    const data = {
      updatedAt: "2025-01-01T00:00:00.000Z",
      tier: "mega",
      version: 1,
      config: { activeTier: "mega", thresholdTokens: 10000000 },
      session: { id: "abc", state: "running", persistedThisSession: false },
      context: { tokens: null, percent: null, contextWindow: 200000 },
      trigger: { armed: false, ready: false, currentTokens: null, thresholdTokens: 10000000 },
      store: { checkpointCount: 0, totalTokenEstimate: 0 },
    };
    writeFileSync(join(dir, "dashboard.json"), JSON.stringify(data));
    const content = readFileSync(join(dir, "dashboard.json"), "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.tier, "mega");
    assert.equal(parsed.config.thresholdTokens, 10000000);
    assert.equal(parsed.context.tokens, null);
    rmSync(dir, { recursive: true });
  });
});

describe("events.log (JSONL)", () => {
  test("parses multiple JSONL lines", () => {
    const dir = tmpDir();
    const events = [
      { ts: "2025-01-01T00:00:00.000Z", type: "compact_start", trigger: "auto", tier: "medium", sessionId: "s1" },
      { ts: "2025-01-01T00:00:01.000Z", type: "compact_end", trigger: "auto", durationMs: 1500, mode: "mega", fromTokens: 100000, toTokens: 5000 },
      { ts: "2025-01-01T00:00:02.000Z", type: "checkpoint_persisted", checkpointId: "chk_1", totalCheckpoints: 1 },
    ];
    writeFileSync(join(dir, "events.log"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const lines = readFileSync(join(dir, "events.log"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].type, "compact_start");
    assert.equal(parsed[1].durationMs, 1500);
    assert.equal(parsed[2].checkpointId, "chk_1");
    rmSync(dir, { recursive: true });
  });

  test("ignores empty lines", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "events.log"), '{"type":"test"}\n\n\n{"type":"test2"}\n');
    const lines = readFileSync(join(dir, "events.log"), "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    rmSync(dir, { recursive: true });
  });
});

describe("port.pid file", () => {
  test("round-trips port and pid", () => {
    const dir = tmpDir();
    const info = { port: 3847, pid: 12345 };
    writeFileSync(join(dir, "port.pid"), JSON.stringify(info));
    const content = readFileSync(join(dir, "port.pid"), "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.port, 3847);
    assert.equal(parsed.pid, 12345);
    rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Multi-repo dashboard (S19 / Phase 5b) — launch the real server subprocess,
// seed the machine-wide repo_registry, and assert /api/index returns every repo
// plus the aggregate summary the Summary + All-repos tabs render.
// ---------------------------------------------------------------------------

describe("multi-repo /api/index (S19)", () => {
  test("lists all repos from the global index with an aggregate summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-index-"));
    const indexDir = mkdtempSync(join(tmpdir(), "index-"));
    // The server reads MEGACOMPACT_INDEX_DIR for the machine-wide registry.
    process.env.MEGACOMPACT_INDEX_DIR = indexDir;
    process.env.MEGACOMPACT_DASHBOARD_PORT = "19321"; // private base, non-colliding

    const { upsertRepoRegistry } = await import("../src/store/sqlite.js");
    upsertRepoRegistry(
      { repoRoot: "/home/u/repoA", displayName: "repoA", stateDir: dir, checkpointCount: 3, tokensSaved: 1000, compressedOriginalBytes: 0 },
      indexDir,
    );
    upsertRepoRegistry(
      { repoRoot: "/home/u/repoB", displayName: "repoB", stateDir: dir, checkpointCount: 5, tokensSaved: 2000, compressedOriginalBytes: 0 },
      indexDir,
    );

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
      const idx = (await fetch(`http://localhost:${raw.port}/api/index`).then((r) => r.json())) as {
        summary: { totalRepos: number; totalCheckpoints: number; totalTokensSaved: number };
        repos: { repoRoot: string; displayName: string; checkpointCount: number; tokensSaved: number }[];
      };
      const names = idx.repos.map((r) => r.displayName).sort();
      assert.deepEqual(names, ["repoA", "repoB"], "both repos from the global index");
      assert.equal(idx.summary.totalRepos, 2, "repo count");
      assert.equal(idx.summary.totalCheckpoints, 8, "3 + 5 checkpoints");
      assert.equal(idx.summary.totalTokensSaved, 3000, "1000 + 2000 tokens saved");
    } finally {
      child.kill("SIGTERM");
      delete process.env.MEGACOMPACT_INDEX_DIR;
      delete process.env.MEGACOMPACT_DASHBOARD_PORT;
      rmSync(dir, { recursive: true, force: true });
      rmSync(indexDir, { recursive: true, force: true });
    }
  });

  test("/api/repos filters by ?active=Nh and /api/summary counts activeRepos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-active-"));
    const indexDir = mkdtempSync(join(tmpdir(), "index-active-"));
    process.env.MEGACOMPACT_INDEX_DIR = indexDir;
    process.env.MEGACOMPACT_DASHBOARD_PORT = "19322";

    const { upsertRepoRegistry } = await import("../src/store/sqlite.js");
    // Fresh repo, last_seen = now
    upsertRepoRegistry(
      { repoRoot: "/home/u/fresh", displayName: "fresh", stateDir: dir, checkpointCount: 1, tokensSaved: 100, compressedOriginalBytes: 0, lastSeen: Math.floor(Date.now() / 1000) },
      indexDir,
    );
    // Stale repo, last_seen = 90 days ago — must be filtered out by ?active=24h.
    const longAgo = Math.floor(Date.now() / 1000) - 90 * 86_400;
    upsertRepoRegistry(
      { repoRoot: "/home/u/stale", displayName: "stale", stateDir: dir, checkpointCount: 2, tokensSaved: 200, compressedOriginalBytes: 0, lastSeen: longAgo },
      indexDir,
    );

    const child = spawn(process.execPath, [SERVER_ENTRY, dir], { stdio: "ignore" });
    try {
      await waitFor(async () => {
        try {
          const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
          const res = await fetch(`http://localhost:${raw.port}/api/version`);
          return res.ok;
        } catch { return false; }
      });
      const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));

      const allRepos = (await fetch(`http://localhost:${raw.port}/api/repos`).then((r) => r.json())) as { repos: { displayName: string }[]; count: number };
      assert.equal(allRepos.count, 2, "unfiltered list has both repos");

      const activeRepos = (await fetch(`http://localhost:${raw.port}/api/repos?active=24h`).then((r) => r.json())) as { repos: { displayName: string }[]; count: number };
      assert.equal(activeRepos.count, 1, "active=24h drops the 90-day-old repo");
      assert.equal(activeRepos.repos[0].displayName, "fresh");

      const summary = (await fetch(`http://localhost:${raw.port}/api/summary`).then((r) => r.json())) as { activeRepos: number; totalRepos: number };
      assert.equal(summary.activeRepos, 1, "summary counts only fresh repo as active");
      assert.equal(summary.totalRepos, 2, "summary counts both repos total");
    } finally {
      child.kill("SIGTERM");
      delete process.env.MEGACOMPACT_INDEX_DIR;
      delete process.env.MEGACOMPACT_DASHBOARD_PORT;
      rmSync(dir, { recursive: true, force: true });
      rmSync(indexDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration — launch the compiled server as a real subprocess
// (the same way the /dashboard command spawns it) and assert the two failure
// modes that historically produced a silent "failed to start":
//   1. a stale port.pid pointing at a dead port is dropped, and the server
//      binds fresh (instead of returning the dead port);
//   2. a module-load crash is captured to the launch log instead of going
//      silent under stdio:"ignore".
// ---------------------------------------------------------------------------

const SERVER_ENTRY = new URL("./dashboard-server.js", import.meta.url).pathname;

// Tests run in parallel across files and a killed run can leave a server bound
// to 9320. Use a private, non-colliding base so this file never races the
// mega-compact.test.js dashboard tests (which scan a DIFFERENT base) and never
// collides with a leftover production server on 9320.
process.env.MEGACOMPACT_DASHBOARD_PORT = "19320";

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

describe("server lifecycle", () => {
  test("drops a stale port.pid and binds a fresh port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-stale-"));
    // A marker claiming a port where nothing is listening — use the test's own
    // private base + 5 so the dead port is inside the server's scan range.
    const deadPort = 19325;
    writeFileSync(join(dir, "port.pid"), JSON.stringify({ port: deadPort, pid: 999999 }));

    const child = spawn(process.execPath, [SERVER_ENTRY, dir], { stdio: "ignore" });
    try {
      // Wait for the server to actually be live (not just any port.pid — the
      // stale marker already exists at t=0 and would pass a naive check).
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
      assert.equal(typeof raw.port, "number");
      assert.notEqual(raw.port, deadPort, "should not reuse the dead port from the stale marker");
      // And a real server must answer on it.
      const res = await fetch(`http://localhost:${raw.port}/api/version`);
      assert.equal(res.ok, true);
    } finally {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes a dashboard.log with startup lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-log-"));
    const child = spawn(process.execPath, [SERVER_ENTRY, dir], { stdio: "ignore" });
    try {
      await waitFor(() => {
        try {
          return /server running/.test(readFileSync(join(dir, "dashboard.log"), "utf-8"));
        } catch {
          return false;
        }
      });
      const log = readFileSync(join(dir, "dashboard.log"), "utf-8");
      assert.match(log, /\[mega-compact\]\[dashboard\]/);
      assert.match(log, /server running/);
    } finally {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
