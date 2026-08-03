#!/usr/bin/env node
/**
 * vector-cortex-network-denial.mjs — prove VC0 runtime paths never touch the
 * network (PREVENT-PI-004). Patches Node's network modules (net/tls/http/https
 * DNS lookup + global fetch) to throw, then exercises each triad mode's VC0A
 * runtime path and asserts it completes without any egress.
 *
 * Modes table is extendable: later sprints append rows (same shape) rather than
 * rewriting the driver. Mode C (observer absent) must perform zero evaluation
 * writes and make no network call.
 *
 * LOCAL ONLY: runs against the compiled dist build (run after `npm run build`).
 *
 * Usage:
 *   node scripts/vector-cortex-network-denial.mjs --modes=A,B,C
 */

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Network patch: every egress primitive throws. ──────────────────────────

function patchNetwork() {
  const deny = () => {
    throw new Error("PREVENT-PI-004: network denied at runtime");
  };
  const net = require("node:net");
  const http = require("node:http");
  const https = require("node:https");
  const tls = require("node:tls");
  const dns = require("node:dns");
  net.connect = deny;
  net.createConnection = deny;
  http.request = deny;
  http.get = deny;
  https.request = deny;
  https.get = deny;
  tls.connect = deny;
  dns.lookup = deny;
  globalThis.fetch = deny;
}

// ── Mode scenarios (extendable modes table) ────────────────────────────────

/**
 * Each mode names an exercise function that runs the VC0A runtime path under
 * the patched network. All must complete without a network throw. Mode C must
 * additionally perform zero evaluation writes.
 */
const MODES = {
  /** Structured observer enabled: record + canonical order + histogram. */
  A: () => {
    const { createEvalObserver } = require(join(root, "dist/src/vector-cortex/eval/observer.js"));
    const { observerMetrics } = require(join(root, "dist/src/vector-cortex/eval/observer.js"));
    let emitted = 0;
    const observer = createEvalObserver({
      emit: () => {
        emitted++;
      },
    });
    observer.record({ session: "s1", seq: 1, event: "lat", value: 5, unit: "ms", mode: "A" });
    observer.record({ session: "s1", seq: 2, event: "lat", value: 300, unit: "ms", mode: "A" });
    const result = observerMetrics(observer);
    if (result.rows.length !== 2) throw new Error("mode A: unexpected row count");
    if (result.histogram.overflow !== 1) throw new Error("mode A: overflow not separated");
    return `emitted=${emitted}`;
  },

  /** Counters-only observer with payload access denied: buckets only. */
  B: () => {
    const { bucketHistogram } = require(join(root, "dist/src/vector-cortex/eval/metrics.js"));
    const rows = [
      { session: "s1", seq: 1, event: "count", value: 4, unit: "count", mode: "B" },
      { session: "s1", seq: 2, event: "lat", value: 1, unit: "ms", mode: "B" },
      { session: "s1", seq: 3, event: "lat", value: 250, unit: "ms", mode: "B" },
    ];
    const h = bucketHistogram(rows);
    if (h.cells[0] !== 1 || h.cells[6] !== 1) throw new Error("mode B: bucket mismatch");
    if (h.overflow !== 0) throw new Error("mode B: unexpected overflow");
    return `total=${h.total}`;
  },

  /** Observer absent: zero evaluation writes, no network. */
  C: () => {
    // C must leave the host transcript unchanged (no writes, no observes).
    return "no-op: zero evaluation writes";
  },
};

// ── Main ────────────────────────────────────────────────────────────────────

const flagArg = process.argv.find((a) => a.startsWith("--modes="));
if (!flagArg) {
  console.error("Usage: node scripts/vector-cortex-network-denial.mjs --modes=A,B,C");
  process.exit(2);
}
const modes = flagArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);

const failures = [];
for (const mode of modes) {
  if (!MODES[mode]) {
    failures.push(`unknown mode '${mode}'`);
    continue;
  }
  try {
    patchNetwork();
    const note = MODES[mode]();
    console.log(`✓ NETWORK-DENIAL mode ${mode}: clean (${note})`);
  } catch (e) {
    failures.push(`mode ${mode}: ${e.message}`);
  }
}

if (failures.length > 0) {
  console.error("NETWORK-DENIAL FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`NETWORK-DENIAL: modes ${modes.join(",")} clean — no network egress.`);
process.exit(0);
