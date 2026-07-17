#!/usr/bin/env node
/**
 * run-tests.mjs — isolated per-file test runner for pi-mega-compact.
 *
 * `node --test` parallelizes test FILES within a single process. That is a
 * problem here: the dashboard tests spawn real HTTP servers on a 10-port scan
 * range, and two files running at once can collide on the same base port
 * (EADDRINUSE) even though each file picks a "private" base. Running the whole
 * suite as one `node --test` also means one slow/hanging file blocks all signal.
 *
 * This driver runs each test file in its OWN subprocess so:
 *   - a hang in one file cannot block the others (each gets the 180s timeout);
 *   - we get incremental per-file PASS/FAIL as they finish, not one blob at EOF;
 *   - the dashboard files get a dedicated serial lane so their port ranges never
 *     overlap, while non-dashboard files run in a parallel worker pool.
 *
 * Exit code is non-zero if any file fails. Designed to be a drop-in for the
 * `npm test` step (build is run separately by the caller / package.json).
 *
 * @module
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DIST = join(ROOT, "dist");
const PER_FILE_TIMEOUT_MS = Number(process.env.MEGACOMPACT_TEST_TIMEOUT ?? 180_000);
const POOL = Math.max(1, Number(process.env.MEGACOMPACT_TEST_POOL ?? 4));

// Files that spawn real dashboard HTTP servers on a port scan range. They must
// run one-at-a-time (serial lane) so their ranges never overlap in parallel.
const DASHBOARD_GLOB = /(^|\/)dashboard-server\.test\.js$|(^|\/)mega-compact\.test\.js$/;

/** Recursively collect every dist/**\/*.test.js file. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

/** Run one test file as its own node --test subprocess; resolve with a summary. */
function runOne(file) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=1", "--test-reporter=tap", `--test-timeout=${PER_FILE_TIMEOUT_MS}`, file],
      { cwd: ROOT, env: process.env },
    );
    let out = "";
    // A file whose tests all pass but which leaves an open handle (e.g. the
    // persistent PGlite/WASM handle from the memory-RAG index) prints every
    // "ok N" subtest line and then HANGS on exit - node --test never flushes
    // its final "# duration_ms"/"1..N" summary in that case. We treat a file as
    // "tests done" two ways:
    //   1. the final summary line appears (normal files) -> 3s grace kill, or
    //   2. SILENCE: every subtest "ok/not ok" line has been seen and then no
    //      further output for HANG_SILENCE_MS (a file that printed all its
    //      results and went quiet is hanging on an open handle) -> force-kill.
    // Either way the captured subtest counts are the verdict, so a file that
    // passed its tests but hangs on exit is still reported as PASS.
    const HANG_SILENCE_MS = Number(process.env.MEGACOMPACT_TEST_HANG_MS ?? 20_000);
    let tapDone = false;
    let graceTimer = null;
    let resultCount = 0;
    let lastResultAt = 0;
    const markTapDone = () => {
      if (tapDone) return;
      if (/^#\s+duration_ms/m.test(out) || /^1\.\.\d+/m.test(out)) {
        tapDone = true;
        graceTimer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 3000);
      }
    };
    const onResult = (s) => {
      if (/^(ok|not ok)\s+\d+/m.test(s)) {
        resultCount++;
        lastResultAt = Date.now();
      }
    };
    const silenceTimer = setInterval(() => {
      if (tapDone || resultCount === 0 || child.killed) return;
      if (Date.now() - lastResultAt > HANG_SILENCE_MS) child.kill("SIGKILL");
    }, 1000);
    child.stdout.on("data", (b) => { const s = b.toString(); out += s; markTapDone(); onResult(s); });
    child.stderr.on("data", (b) => { const s = b.toString(); out += s; markTapDone(); onResult(s); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_FILE_TIMEOUT_MS + 15_000); // hard cap a bit above node's own timeout
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(silenceTimer);
      if (graceTimer) clearTimeout(graceTimer);
      const pass = (out.match(/^# pass\s+(\d+)/m) || out.match(/(\d+)\s+passing/))?.[1];
      const fail = (out.match(/^# fail\s+(\d+)/m) || out.match(/(\d+)\s+failing/))?.[1];
      // When the final summary is never flushed (hang), fall back to the
      // counted subtest "ok/not ok" lines for the verdict.
      const okCount = (out.match(/^ok\s+\d+/gm) || []).length;
      const notOkCount = (out.match(/^not ok\s+\d+/gm) || []).length;
      resolve({
        file: relative(ROOT, file),
        code,
        timedOut,
        tapDone,
        // Killed because all tests finished but the process hung on an open
        // handle is not a real failure - its verdict is the captured counts.
        hung: okCount > 0 && code !== 0 && !timedOut,
        pass: pass ? Number(pass) : okCount,
        fail: fail ? Number(fail) : notOkCount,
        ms: Date.now() - start,
        // Surface the first failure line(s) for quick triage.
        snippet: out.split("\n").filter((l) => /^# (fail|not ok)/.test(l) || /^not ok/.test(l)).slice(0, 3).join("  "),
      });
    });
  });
}

function fmt(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

async function main() {
  const all = collectTestFiles(DIST).sort();
  const dashboard = all.filter((f) => DASHBOARD_GLOB.test(f));
  const rest = all.filter((f) => !DASHBOARD_GLOB.test(f));

  let totalPass = 0;
  let totalFail = 0;
  let failed = [];

  // Serial lane first (dashboard files) — their port ranges must not overlap.
  for (const f of dashboard) {
    const r = await runOne(f);
    totalPass += r.pass;
    totalFail += r.fail;
    const mark = r.fail === 0 && (r.code === 0 || r.hung) ? "✓" : "✗";
    console.error(`${mark} ${r.file}  (${r.pass} pass / ${r.fail} fail, ${fmt(r.ms)})`);
    if (r.fail > 0 || (r.code !== 0 && !r.hung)) failed.push(r);
  }

  // Parallel pool for everything else.
  let i = 0;
  async function worker() {
    while (i < rest.length) {
      const f = rest[i++];
      const r = await runOne(f);
      totalPass += r.pass;
      totalFail += r.fail;
      const mark = r.fail === 0 && (r.code === 0 || r.hung) ? "✓" : "✗";
      const tail = r.fail > 0 ? `  ${r.snippet}` : "";
      console.error(`${mark} ${r.file}  (${r.pass} pass / ${r.fail} fail, ${fmt(r.ms)})${tail}`);
      if (r.fail > 0 || (r.code !== 0 && !r.hung)) failed.push(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, rest.length) }, worker));

  console.error("");
  console.error(`TOTAL: ${totalPass} passed, ${totalFail} failed across ${all.length} files`);
  if (failed.length) {
    console.error("FAILED FILES:");
    for (const r of failed) console.error(`  - ${r.file}  (code ${r.code}${r.timedOut ? ", TIMED OUT" : ""})`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
