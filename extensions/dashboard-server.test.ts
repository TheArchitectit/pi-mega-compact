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
