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
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_FILE_TIMEOUT_MS + 15_000); // hard cap a bit above node's own timeout
    child.on("close", (code) => {
      clearTimeout(timer);
      const pass = (out.match(/^# pass\s+(\d+)/m) || out.match(/(\d+)\s+passing/))?.[1];
      const fail = (out.match(/^# fail\s+(\d+)/m) || out.match(/(\d+)\s+failing/))?.[1];
      resolve({
        file: relative(ROOT, file),
        code,
        timedOut,
        pass: pass ? Number(pass) : 0,
        fail: fail ? Number(fail) : 0,
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
    const mark = r.fail === 0 && r.code === 0 ? "✓" : "✗";
    console.error(`${mark} ${r.file}  (${r.pass} pass / ${r.fail} fail, ${fmt(r.ms)})`);
    if (r.fail > 0 || r.code !== 0) failed.push(r);
  }

  // Parallel pool for everything else.
  let i = 0;
  async function worker() {
    while (i < rest.length) {
      const f = rest[i++];
      const r = await runOne(f);
      totalPass += r.pass;
      totalFail += r.fail;
      const mark = r.fail === 0 && r.code === 0 ? "✓" : "✗";
      const tail = r.fail > 0 ? `  ${r.snippet}` : "";
      console.error(`${mark} ${r.file}  (${r.pass} pass / ${r.fail} fail, ${fmt(r.ms)})${tail}`);
      if (r.fail > 0 || r.code !== 0) failed.push(r);
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
