#!/usr/bin/env node
/**
 * dedup-benchmark.mjs — Sprint 15.1 end-to-end benchmarks.
 *
 * Drives VectorStore.add()/search() at 100 / 1K / 10K checkpoints and reports,
 * per scale:
 *   - dedup hit rate      (deduped adds / total adds)
 *   - compression ratio   (raw region bytes / smart-compressed bytes; target >= 5:1)
 *   - per-tier p95 latency (from the structured events.log the store writes)
 *   - storage savings     (unique rows stored vs inputs, and on-disk sqlite.db bytes)
 *
 * Fully local, deterministic (seeded PRNG — no Math.random), zero network
 * (PREVENT-PI-004). Uses the compiled dist/ modules, so run `npm run build` first.
 *
 * Usage:
 *   node scripts/dedup-benchmark.mjs [scales...]   # default: 100 1000 10000
 *   node scripts/dedup-benchmark.mjs 100 1000       # custom scales
 */

import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distSrc = join(root, "dist", "src");

// Compiled modules (require `npm run build`).
const { VectorStore } = await import(join(distSrc, "vectorStore.js"));
const { loadDedupConfig } = await import(join(distSrc, "config", "dedup.js"));
const { closeStore } = await import(join(distSrc, "store", "sqlite.js"));
const { compressSmart } = await import(join(distSrc, "store", "compression.js"));
const { p95 } = await import(join(distSrc, "monitoring.js"));

/** Deterministic mulberry32 PRNG (no Math.random → reproducible benchmarks). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = ["parser", "cache", "walrus", "glacier", "nebula", "loom", "anvil",
  "ferry", "orchid", "rover", "scribe", "photon", "reactor", "canyon", "trellis",
  "galleon", "comet", "beehive", "cedar", "quartz", "violin", "amphora", "sonar"];
const VERBS = ["optimized", "sampled", "forged", "charted", "tuned", "calved",
  "cataloged", "sutured", "threaded", "navigated", "extracted", "imaged"];
const TAILS = ["under the theatre lights", "beside the polar ice shelf",
  "at the riverside studio", "across the churning wake", "in the cloud forest",
  "deep in the shaft", "beneath the streetlamp", "atop a windswept cliff"];

/** Build a corpus of `n` regions with a controlled duplicate fraction. */
function buildCorpus(n, dupFraction, seed) {
  const rand = mulberry32(seed);
  const uniques = [];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (uniques.length > 0 && rand() < dupFraction) {
      // Re-emit an existing region verbatim (exact L0 dup) or with a one-word
      // tweak (L1/L2 near-dup) so multiple tiers exercise.
      const base = uniques[Math.floor(rand() * uniques.length)];
      out.push(rand() < 0.5 ? base : `${base} indeed`);
    } else {
      const noun = NOUNS[Math.floor(rand() * NOUNS.length)];
      const verb = VERBS[Math.floor(rand() * VERBS.length)];
      const tail = TAILS[Math.floor(rand() * TAILS.length)];
      const region = `The ${noun} ${verb} the ${NOUNS[Math.floor(rand() * NOUNS.length)]} ${tail} (rec ${i})`;
      uniques.push(region);
      out.push(region);
    }
  }
  return out;
}

function fmt(n) { return n.toLocaleString("en-US"); }

function runScale(n) {
  const dir = mkdtempSync(join(tmpdir(), `mc-bench-${n}-`));
  const eventsPath = join(dir, "events.log");
  const store = new VectorStore({ stateDir: dir, config: loadDedupConfig(), eventsPath });

  const corpus = buildCorpus(n, 0.35, 0x5eed ^ n);
  let deduped = 0;
  let rawBytes = 0;
  let compressedBytes = 0;

  const t0 = Date.now();
  for (let i = 0; i < corpus.length; i++) {
    const regionText = corpus[i];
    rawBytes += Buffer.byteLength(regionText, "utf-8");
    compressedBytes += compressSmart(Buffer.from(regionText, "utf-8")).length;
    const res = store.add({
      sessionId: "sess_bench",
      summary: `checkpoint ${i}`,
      regionText,
      timestamp: i,
    });
    if (res.deduped) deduped++;
  }
  const addMs = Date.now() - t0;

  // A representative search to confirm retrieval works at scale (timed).
  const s0 = Date.now();
  const hits = store.search("sess_bench", "the cache optimized the parser", 5);
  const searchMs = Date.now() - s0;

  // Per-tier p95 from the structured events.log.
  const perTier = { L0: [], L1: [], L2: [], RAPTOR: [] };
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (perTier[ev.tier]) perTier[ev.tier].push(ev.latencyMs);
      } catch { /* skip malformed */ }
    }
  }

  const stored = store.list("sess_bench").length;
  const dbBytes = existsSync(join(dir, "sqlite.db")) ? statSync(join(dir, "sqlite.db")).size : 0;
  const compressionRatio = compressedBytes > 0 ? rawBytes / compressedBytes : 0;

  closeStore(dir);
  rmSync(dir, { recursive: true, force: true });

  return {
    n,
    stored,
    deduped,
    dedupHitRate: deduped / n,
    compressionRatio,
    rawBytes,
    compressedBytes,
    dbBytes,
    addMsPerOp: addMs / n,
    searchMs,
    searchHits: hits.length,
    p95: {
      L0: p95(perTier.L0),
      L1: p95(perTier.L1),
      L2: p95(perTier.L2),
    },
  };
}

// --- main --------------------------------------------------------------------

const scales = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0);
const SCALES = scales.length ? scales : [100, 1000, 10000];

console.log("pi-mega-compact — dedup benchmark (Sprint 15.1)");
console.log(`scales: ${SCALES.map(fmt).join(", ")}  |  embedder: ${process.env.MEGACOMPACT_EMBEDDER ?? "trigram"}`);
console.log("=".repeat(78));

const results = [];
for (const n of SCALES) {
  const r = runScale(n);
  results.push(r);
  console.log(`
── ${fmt(n)} checkpoints ─────────────────────────────────────────────`);
  console.log(`  dedup hit rate     : ${(r.dedupHitRate * 100).toFixed(1)}%  (${fmt(r.deduped)} of ${fmt(n)} collapsed; ${fmt(r.stored)} rows stored)`);
  console.log(`  compression ratio  : ${r.compressionRatio.toFixed(2)}:1  (${fmt(r.rawBytes)}B raw → ${fmt(r.compressedBytes)}B)  ${r.compressionRatio >= 5 ? "✓ ≥5:1" : "(text corpus; see note)"}`);
  console.log(`  storage (sqlite.db): ${fmt(r.dbBytes)}B`);
  console.log(`  add latency        : ${r.addMsPerOp.toFixed(3)} ms/op`);
  console.log(`  per-tier p95 (ms)  : L0=${r.p95.L0.toFixed(2)}  L1=${r.p95.L1.toFixed(2)}  L2=${r.p95.L2.toFixed(2)}`);
  console.log(`  search             : ${r.searchMs} ms → ${r.searchHits} hits`);
}

console.log(`\n${"=".repeat(78)}`);
console.log("Notes:");
console.log("  • Compression ratio target (≥5:1) applies to real ~70K-token compacted");
console.log("    regions; the synthetic short strings here undercount it — the metric");
console.log("    and measurement path are what this benchmark proves.");
console.log("  • All figures are local + deterministic (seeded PRNG); zero network.");

// Emit machine-readable JSON on the last line for CI capture.
console.log(`BENCH_JSON=${JSON.stringify(results)}`);
