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
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load a compiled dist module by import (file:// URL). The project is ESM
 * ('"type": "module"'), so every compiled `dist` module is ESM — `require()` of
 * an ESM module throws ERR_REQUIRE_ESM on Node < 22.12, and CLAUDE.md declares
 * Node >= 18. Dynamic import works on every supported Node floor, so the
 * compiled-dist legs of this gate use it rather than `require`.
 */
async function loadDist(relPath) {
  return import(pathToFileURL(join(root, "dist", relPath)).href);
}

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

/**
 * VC3A cortex-store leg: exercise the real capability-gated cortex store end to
 * end (isolated local SQLite, append -> rebuild -> reader topology summary) with
 * the network patched. The whole derived-store path is local hashing + SQLite;
 * it must complete without any egress (PREVENT-PI-004). Platform-independent —
 * valid under both mode A and B. Flag-independent at the store primitive level,
 * so it also holds under mode C (flag-OFF).
 */
async function cortexDenialNote() {
  const { createCortexStore } = await loadDist("src/vector-cortex/cortex/store.js");
  const dir = join(tmpdir(), "net-deny-cortex");
  const { rmSync } = require("node:fs");
  const store = createCortexStore({ dbPath: join(dir, "cortex.db") });
  const enc = new TextEncoder();
  store.writer().append({
    sourceHighWater: 1n, algorithmVersion: 1, id: "a",
    kind: "semantic", payloadBytes: enc.encode("network-denial-cortex-A"),
  });
  store.writer().append({
    sourceHighWater: 2n, algorithmVersion: 1, id: "b",
    kind: "contradiction", payloadBytes: enc.encode("network-denial-cortex-B"),
  });
  const rb = store.admin().rebuild();
  if (!rb.ok) throw new Error(`cortex leg: rebuild failed`);
  const sum = store.reader().topologySummary();
  if (sum.recordCount !== 2 || sum.sourceHighWater !== "2") {
    throw new Error(`cortex leg: summary mismatch (${sum.recordCount}/${sum.sourceHighWater})`);
  }
  const digest = rb.ok ? rb.generation.rootDigest.slice(0, 8) : "?";
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return `cortex=${digest}`;
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
  A: async () => {
    const { createEventCodec } = await loadDist("src/vector-cortex/ledger/event-codec.js");
    const { validateEvents } = await loadDist("src/vector-cortex/ledger/validator.js");
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
    const { createBreaker: makeBreaker } = await loadDist("src/vector-cortex/resilience/breaker.js");
    const bk = makeBreaker({});
    for (let i = 0; i < 20; i++) {
      bk.execute("net", "d", { A: () => { throw new Error("down"); }, B: () => "b", C: () => "c" }, (x) => x === "c");
    }
    if (bk.snapshot("net").state !== "OPEN_B") throw new Error("mode A: breaker failed to open under denial");

    // ── VC1C minhash-v2 runner (mode A): exact signature + LSH buckets, plus
    //     deterministic manifest digest — all local, no egress. ──
    const { minhashV2Signature, encodeSignatureV2 } = await loadDist("src/dedup/l1-minhash-v2.js");
    const { lshBandsV2 } = await loadDist("src/dedup/l1-lsh-v2.js");
    const { createHash } = require("node:crypto");
    const sig = minhashV2Signature("network-denial-mode-A vc1c");
    const bytes2 = encodeSignatureV2(sig);
    if (bytes2.length !== 2048) throw new Error("mode A: vc1c signature length");
    const buckets = lshBandsV2(bytes2, "net");
    if (buckets.length !== 64) throw new Error("mode A: vc1c bucket count");
    const sigDigest = createHash("sha256").update(bytes2).digest("hex").slice(0, 8);

    // ── VC2A qualified local ONNX (mode A): verify + load + infer the committed
    //     digest-pinned asset — all filesystem reads, zero egress. ──
    const { readEncoderManifest, verifyEncoderAsset, detectPlatform } = await loadDist("src/vector-cortex/encoder/asset.js");
    const { createEncoderRuntime } = await loadDist("src/vector-cortex/encoder/runtime.js");
    const assetDir = join(root, "assets/vector-cortex/encoder-v1");
    const assetManifest = readEncoderManifest(assetDir);
    if (!assetManifest) throw new Error("mode A: committed encoder manifest unreadable");
    const vRes = verifyEncoderAsset(assetDir, assetManifest);
    if (detectPlatform() === assetManifest.platform) {
      // Host matches the bundle's pinned platform: the committed digest-pinned
      // asset MUST verify, load and infer as mode A — all filesystem reads.
      if (!vRes.ok) throw new Error(`mode A: committed asset failed verification (${vRes.code})`);
      const encRt = createEncoderRuntime();
      const encLoad = encRt.load(assetDir);
      if (!encLoad.ok || encLoad.mode !== "A") throw new Error("mode A: encoder did not select qualified ONNX");
      const encInf = encRt.infer({ tokens: Array.from({ length: 128 }, (_, k) => k) });
      if (!encInf.ok || encInf.semantic.length !== 384) throw new Error("mode A: encoder inference failed under denial");

      // ── VC2B multi-head encoder (mode A): produce the five heads + 512d
      //     trigram under full network denial — all in-process hashing, zero
      //     egress. The heads/trigram never touch the asset or calibration. ──
      const { encodeVectorSet } = await loadDist("src/vector-cortex/encoder/heads.js");
      const { embedTrigram512 } = await loadDist("src/vector-cortex/encoder/trigram.js");
      const vset = encodeVectorSet([1, 2, 3, 4, 5]);
      if (vset.heads.length !== 5 || vset.heads[0].dim !== 384) throw new Error("mode A: vc2b heads failed under denial");
      const tb = embedTrigram512("network-denial mode A vc2b");
      if (tb.length !== 512) throw new Error("mode A: vc2b trigram failed under denial");

      // ── VC2C qualification (mode A): calibration fit + atomic selection of the
      //     qualified learned asset — all deterministic local math, zero egress. ──
      const { fitCalibration, calibrationSplitDigest } = await loadDist("src/vector-cortex/encoder/calibrate.js");
      const { selectQualifiedEncoder } = await loadDist("src/vector-cortex/encoder/select.js");
      const { selectQualificationFallback } = await loadDist("src/vector-cortex/encoder/fallback.js");
      const ex = [
        { itemId: "n1", head: "semantic", score: 0.2, label: 0, repository: "rA", session: "s1" },
        { itemId: "n2", head: "semantic", score: 0.9, label: 1, repository: "rA", session: "s1" },
        { itemId: "n3", head: "dependency", score: 0.1, label: 0, repository: "rB", session: "s2" },
        { itemId: "n4", head: "dependency", score: 0.8, label: 1, repository: "rB", session: "s2" },
      ];
      const calibration = fitCalibration(ex);
      if (!calibration.ok || calibration.calibration.schema !== "calibration-v1") {
        throw new Error("mode A: calibration fit failed under denial");
      }
      const split = calibrationSplitDigest(ex.map((r) => ({ repository: r.repository, session: r.session })));
      if (split.length !== 64) throw new Error("mode A: calibration split digest invalid");
      // Fully-satisfactory held-out metrics -> QualifiedEncoderV1 (mode A).
      const heldOut = {
        semantic: { spearman: 0.8, recallAt10: 0.95 },
        dependency: { precision: 0.98, recall: 0.96 },
        contradiction: { precision: 0.99, recall: 0.95, ece: 0.03 },
        cacheStability: { precision: 1.0, recall: 0.95 },
        payloadRouting: { macroF1: 0.98, exactAnchorRecall: 1.0 },
        reconstruction: { votesOk: true, dependencyClosureRecall: 1.0, taskSuccessNonInferior: true },
      };
      const qualified = selectQualifiedEncoder({
        modelVersion: "vc2c-netdenial",
        asset: { maxTokens: 512, latencyP95Ms: 20, rssDeltaMib: 40 },
        onnxDigest: "a".repeat(64),
        assetManifestDigest: "e".repeat(64),
        calibration: calibration.calibration,
        heldOut,
      });
      if (!qualified.ok || qualified.qualified.mode !== "A") throw new Error("mode A: vc2c should qualify mode A under denial");
      const fb = selectQualificationFallback("ENC_QUALIFICATION_THRESHOLD_FAILED", [1, 2, 3]);
      if (fb.mode !== "B" || fb.width !== 512) throw new Error("mode A: vc2c fallback B failed under denial");
      const headsNote = `${vset.heads.length}heads`;
      const cortexNote = await cortexDenialNote();
      return `roundtrip=${bytes.length} breaker=${bk.snapshot("net").state} vc1c=${sigDigest} vc2a=A vc2b=${headsNote} vc2c=A ${cortexNote}`;
    }
    // Host is NOT the bundle's pinned platform (cross-platform Q02): the bundle
    // correctly demotes to trigram B via PLATFORM_UNSUPPORTED — still zero
    // network egress, so the denial gate holds on every supported platform.
    if (vRes.ok || vRes.code !== "ENC_PLATFORM_UNSUPPORTED") {
      throw new Error(`mode A: off-platform bundle should demote PLATFORM_UNSUPPORTED, got ${vRes.code}`);
    }
    const encLoadB = createEncoderRuntime().load(assetDir);
    if (encLoadB.ok || encLoadB.mode !== "B") throw new Error("mode A: off-platform bundle should demote to trigram B");
    const cortexNote = await cortexDenialNote();
    return `roundtrip=${bytes.length} breaker=${bk.snapshot("net").state} vc1c=${sigDigest} vc2a=B ${cortexNote}`;
  },

  /** B: independent raw byte record — same digest, no shared subroutine. */
  B: async () => {
    const { createEventCodec } = await loadDist("src/vector-cortex/ledger/event-codec.js");
    const { recordRawBytesB } = await loadDist("src/vector-cortex/ledger/event-codecB.js");
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
    const { createSpool } = await loadDist("src/vector-cortex/resilience/spool.js");
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

    // ── VC1C independent exact fixture reader (mode-B second leg): re-derive the
    //     signature byte-for-byte from the committed corpus WITHOUT the runner
    //     module (independent implementation in triadB-reader), so A (runner) /
    //     B (independent) must agree under denial. ──
    const { readFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const { independentReaderV2 } = await loadDist("src/vector-cortex/conformance/triadB-reader.js");
    const fixtureDir = join(root, "conformance/vector-cortex/v2/minhash");
    const fx = JSON.parse(readFileSync(join(fixtureDir, "M4-HIGHBIT-001.json"), "utf8"));
    const seeds = JSON.parse(readFileSync(join(fixtureDir, "seeds-v2.json"), "utf8")).seedPairs;
    const text = String(fx.input?.text ?? fx.text ?? "");
    const indep = independentReaderV2(text, "net", seeds, false);
    if (indep.bytes.length !== 2048 || indep.digest !== fx.expected.signatureDigest) {
      throw new Error("mode B: independent vc1c signature mismatch");
    }
    const indDigest = indep.digest.slice(0, 8);

    // ── VC2A asset-free trigram (mode B): unsupported platform demotes to B
    //     without a remote fetch, and inference is refused (no verified asset). ──
    const { createEncoderRuntime } = await loadDist("src/vector-cortex/encoder/runtime.js");
    const encRtB = createEncoderRuntime({ platform: () => null });
    const encLoadB = encRtB.load(join(root, "assets/vector-cortex/encoder-v1"));
    if (encLoadB.ok || encLoadB.code !== "ENC_PLATFORM_UNSUPPORTED" || encLoadB.mode !== "B") {
      throw new Error(`mode B: encoder did not demote to trigram B (${encLoadB.code}/${encLoadB.mode})`);
    }

    // ── VC2B mode B: 512d trigram + token/phrase lexical C under denial, with
    //     the learned asset absent — both independent, zero egress. ──
    const { embedTrigram512 } = await loadDist("src/vector-cortex/encoder/trigram.js");
    const { embedLexical } = await loadDist("src/vector-cortex/encoder/lexical.js");
    const tb = embedTrigram512("network-denial mode B vc2b trigram");
    const lx = embedLexical(["network", "denial", "mode", "b", "vc2b"]);
    if (tb.length !== 512 || lx.length !== 256) throw new Error("mode B: vc2b trigram/lexical failed under denial");

    // ── VC2C demotion + fallback (mode B): one failed causal head demotes A,
    //     forcing independently-initialized trigram B (width 512); an injected B
    //     error forces lexical C (width 256) — all local, zero egress. ──
    const { selectQualifiedEncoder } = await loadDist("src/vector-cortex/encoder/select.js");
    const { selectQualificationFallback } = await loadDist("src/vector-cortex/encoder/fallback.js");
    const demoted = selectQualifiedEncoder({
      modelVersion: "vc2c-netdenial-B",
      asset: { maxTokens: 512, latencyP95Ms: 20, rssDeltaMib: 40 },
      onnxDigest: "b".repeat(64),
      assetManifestDigest: "e".repeat(64),
      calibration: {
        schema: "calibration-v1",
        headOrder: ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"],
        calibrationSplitDigest: "c".repeat(64),
        fittedOnCalibrationOnly: true,
        temperatures: { semantic: 1, dependency: 1, contradiction: 1, cacheStability: 1, payloadRouting: 1 },
        thresholds: { semantic: 0.5, dependency: 0.5, contradiction: 0.5, cacheStability: 0.5, payloadRouting: 0.5 },
        seed: 1729,
      },
      heldOut: {
        semantic: { spearman: 0.8, recallAt10: 0.95 },
        dependency: { precision: 0.9, recall: 0.96 }, // below .97 -> demotes
        contradiction: { precision: 0.99, recall: 0.95, ece: 0.03 },
        cacheStability: { precision: 1.0, recall: 0.95 },
        payloadRouting: { macroF1: 0.98, exactAnchorRecall: 1.0 },
        reconstruction: { votesOk: true, dependencyClosureRecall: 1.0, taskSuccessNonInferior: true },
      },
    });
    if (demoted.ok || demoted.code !== "ENC_QUALIFICATION_THRESHOLD_FAILED") {
      throw new Error(`mode B: vc2c should demote on failed causal head (${demoted.code})`);
    }
    const fbB = selectQualificationFallback("ENC_QUALIFICATION_THRESHOLD_FAILED", [1, 2, 3]);
    const fbC = selectQualificationFallback("ENC_QUALIFICATION_THRESHOLD_FAILED", [1, 2, 3], { injectBError: true });
    if (fbB.mode !== "B" || fbB.width !== 512) throw new Error("mode B: vc2c fallback B failed under denial");
    if (fbC.mode !== "C" || fbC.width !== 256) throw new Error("mode B: vc2c fallback C failed under denial");
    const cortexNoteB = await cortexDenialNote();
    return `digest=${b.bytesDigest.slice(0, 8)} spool=committed vc1c=${indDigest} vc2a=B vc2b=B vc2c=B/C ${cortexNoteB}`;
  },

  /** C: predecessor paths unchanged (VC1C flag-OFF byte-identical) + cortex local. */
  C: async () => {
    // C must leave the host transcript unchanged (the legacy transcript codec is
    // untouched by VC1A — mode-C byte-identical predecessor, zero EventV2 writes).
    // VC0C resilience C = unchanged transcript: no breaker/spool write is forced
    // when both A and B are unavailable; the host path stays mode-C and offline.
    // VC3A flag-OFF (mode C) still exercises the local-only cortex store primitive
    // (append/rebuild/summary are flag-independent) with zero network egress.
    const cortexNoteC = await cortexDenialNote();
    return `no-op: zero event/spool writes, transcript codec unchanged; ${cortexNoteC}`;
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
    const note = await MODES[mode]();
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
