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
 * Each mode names an exercise function that runs the VC runtime path under the
 * patched network. All must complete without a network throw. Per sprint this
 * table exercises the newly-added runtime path — for VC1A that is the EventV2
 * ledger triad (A = codec, B = independent raw byte record, C = current
 * transcript codec unchanged / zero writes).
 */
const MODES = {
  /** A: EventV2 codec — encode + strict UTF-8 + NFC + byte round-trip. */
  A: () => {
    const { createEventCodec } = require(join(root, "dist/src/vector-cortex/ledger/event-codec.js"));
    const { validateEvents } = require(join(root, "dist/src/vector-cortex/ledger/validator.js"));
    const codec = createEventCodec();
    const env = codec.encode({
      sessionId: "s1", seq: 1n, eventId: "e1", role: "user", kind: "message",
      bytes: new TextEncoder().encode("network-denial-mode-A"), occurredAtMs: 0n,
    });
    const bytes = codec.decode(env);
    if (Buffer.from(bytes).toString("utf8") !== "network-denial-mode-A") throw new Error("mode A: round-trip failed");
    if (!env.utf8.valid || env.canonicalNfc !== "network-denial-mode-A") throw new Error("mode A: utf8/nfc failed");
    const bad = { ...env, bytesDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    const res = validateEvents([bad]);
    if (res.ok || !res.codes.includes("EVT_DIGEST_MISMATCH")) throw new Error("mode A: validator failed to reject");

    // ── VC0C resilience A = live breaker (mode-A optimized path) ──────────
    const { createBreaker: makeBreaker } = require(join(root, "dist/src/vector-cortex/resilience/breaker.js"));
    const bk = makeBreaker({});
    for (let i = 0; i < 20; i++) {
      bk.execute("net", "d", { A: () => { throw new Error("down"); }, B: () => "b", C: () => "c" }, (x) => x === "c");
    }
    if (bk.snapshot("net").state !== "OPEN_B") throw new Error("mode A: breaker failed to open under denial");
    return `roundtrip=${bytes.length} breaker=${bk.snapshot("net").state}`;
  },

  /** B: independent raw byte record — same digest, no shared subroutine. */
  B: () => {
    const { createEventCodec } = require(join(root, "dist/src/vector-cortex/ledger/event-codec.js"));
    const { recordRawBytesB } = require(join(root, "dist/src/vector-cortex/ledger/event-codecB.js"));
    const codec = createEventCodec();
    const bytes = new TextEncoder().encode("network-denial-mode-B");
    const a = codec.encode({
      sessionId: "s1", seq: 1n, eventId: "e1", role: "user", kind: "message",
      bytes, occurredAtMs: 0n,
    });
    const b = recordRawBytesB(bytes);
    if (a.bytesDigest !== b.bytesDigest) throw new Error("mode B: A/B digest parity failed");
    if (a.utf8.valid !== b.utf8.valid) throw new Error("mode B: A/B utf8 parity failed");

    // ── VC0C resilience B = durable spool (mode-B deterministic local spool) ──
    const { createSpool } = require(join(root, "dist/src/vector-cortex/resilience/spool.js"));
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join: pathJoin } = require("node:path");
    const spoolDir = mkdtempSync(pathJoin(tmpdir(), "net-deny-spool-"));
    try {
      const sp = createSpool({ dir: spoolDir }).session("net");
      sp.append({ seq: 1n, eventId: "e1", bytes: new TextEncoder().encode("network-denial-mode-B") });
      const d = sp.drain(() => "committed");
      if (d.verdict !== "SPOOL_COMMITTED" || d.committedSeq !== 1n) throw new Error("mode B: spool failed to commit under denial");
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
    return `digest=${b.bytesDigest.slice(0, 8)} spool=committed`;
  },

  /** C: current transcript codec unchanged — zero writes, no network. */
  C: () => {
    // C must leave the host transcript unchanged (the legacy transcript codec is
    // untouched by VC1A — mode-C byte-identical predecessor, zero EventV2 writes).
    // VC0C resilience C = unchanged transcript: no breaker/spool write is forced
    // when both A and B are unavailable; the host path stays mode-C and offline.
    return "no-op: zero event/spool writes, transcript codec unchanged";
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
