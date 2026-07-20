/**
 * perf-server.test.ts — v0.8.8 /api/perf endpoint (GET aggregates + 405).
 * Mirrors the server.test.ts spawn-and-fetch harness (self-contained so the
 * dashboard HTTP-port lane stays isolated).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { recordPerfSample } from "../../src/store/sqlite.js";

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

interface PerfResp {
  sampleCount: number;
  turn_latency_ms: { p50: number; p95: number; n: number };
  provider_latency_ms: { p50: number; p95: number; n: number };
  tps: { avg: number; n: number };
  cache_hit_pct: { avg: number; latest: number; n: number };
  db_recompute_ms: { p50: number; p95: number; n: number };
  disk_write_ms: { p50: number; p95: number; n: number };
  rss_mb: { latest: number; n: number };
  heap_mb: { latest: number; n: number };
  cpu_user_ms: { latest: number; n: number };
  cpu_sys_ms: { latest: number; n: number };
  diag: { ctxFastGate: number; liveTrimFires: number; liveTrimReplays: number } | null;
}

describe("v0.8.8 /api/perf", () => {
  test("GET returns aggregates over recorded perf_samples", async () => {
    const dir = freshDir("dash-perf-agg-");
    recordPerfSample(dir, "turn_latency_ms", 100, { turnIndex: 1 });
    recordPerfSample(dir, "turn_latency_ms", 200);
    recordPerfSample(dir, "tps", 50);
    recordPerfSample(dir, "rss_mb", 256);
    await withServer("19440", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/perf?minutes=30`);
      assert.equal(res.status, 200);
      const d = (await res.json()) as PerfResp;
      assert.equal(d.sampleCount, 4);
      assert.equal(d.turn_latency_ms.n, 2);
      assert.equal(d.turn_latency_ms.p50, 100); // nearest-rank p50 of [100,200]
      assert.equal(d.turn_latency_ms.p95, 200); // nearest-rank p95 of [100,200]
      assert.equal(d.tps.avg, 50);
      assert.equal(d.rss_mb.latest, 256);
      assert.equal(d.diag, null); // no runtime wrote dashboard.json in this dir
    });
  });

  test("non-GET (POST) -> 405", async () => {
    const dir = freshDir("dash-perf-meth-");
    await withServer("19441", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/perf`, { method: "POST" });
      assert.equal(res.status, 405);
    });
  });
});
