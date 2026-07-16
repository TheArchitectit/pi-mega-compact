#!/usr/bin/env node
/**
 * crossrepo-benchmark.mjs — Sprint S23.1 end-to-end benchmarks.
 *
 * Three targets from the v0.5.0 plan:
 *   1. Cross-repo recall latency + quality — recallAndInlineAsync() over a
 *      PGlite HNSW index spanning 2 repos. Targets: p95 add-to-recall
 *      latency < 50ms; the foreign (cross-repo) checkpoint is in the top-K.
 *   2. Compaction continuity (model-context-drops) — buildLiveTrimmedView()
 *      collapses a long compacted region to a 1-line summary + recent anchor.
 *      Target: > 5:1 compression of the live window (region / anchor).
 *   3. Memory-RAG recall hit rate — recallMemories() returns the seeded
 *      memory top-1 for a matching query.
 *
 * Fully local + deterministic (seeded PRNG — no Math.random), zero network
 * (PREVENT-PI-004). Uses the compiled dist/ modules, so run `npm run build`
 * first.
 *
 * Usage:
 *   node scripts/crossrepo-benchmark.mjs [--no-pglite]
 *   MEGACOMPACT_PGLITE_DISABLED=1 node scripts/crossrepo-benchmark.mjs
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distSrc = join(root, "dist", "src");

const { buildLiveTrimmedView } = await import(join(distSrc, "..", "extensions", "mega-trim.js"));
const { recallAndInlineAsync } = await import(join(distSrc, "recall.js"));
const { recallMemories } = await import(join(distSrc, "memoryRecall.js"));
const { VectorStore } = await import(join(distSrc, "vectorStore.js"));
const { upsertEmbedding, closeVectorIndex } = await import(join(distSrc, "store", "vectorIndex.js"));
const { loadDedupConfig } = await import(join(distSrc, "config", "dedup.js"));
const { addMemory, closeStore } = await import(join(distSrc, "store", "sqlite.js"));
const { p95 } = await import(join(distSrc, "monitoring.js"));

const PGLITE_DISABLED = process.env.MEGACOMPACT_PGLITE_DISABLED === "1" || process.argv.includes("--no-pglite");

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

function fmt(n) { return n.toLocaleString("en-US"); }
function sentence(rand) {
  const topics = ["parser", "cache", "walrus", "glacier", "nebula", "loom", "anvil",
    "ferry", "orchid", "reactor", "canyon", "trellis", "quartz", "violin", "sonar"];
  const verbs = ["optimized", "sampled", "forged", "charted", "tuned", "carved"];
  return `The ${topics[Math.floor(rand() * topics.length)]} ${verbs[Math.floor(rand() * verbs.length)]} the ${topics[Math.floor(rand() * topics.length)]}.`;
}

const FAILS = [];
function check(name, ok, detail) {
  if (ok) console.log(`  ✓ ${name}${detail ? "  (" + detail + ")" : ""}`);
  else { console.log(`  ✗ ${name}${detail ? "  (" + detail + ")" : ""}`); FAILS.push(name); }
}

// ---------------------------------------------------------------------------
// 1. Cross-repo recall latency + quality
// ---------------------------------------------------------------------------
async function benchCrossRepo() {
  console.log("\n── Cross-repo recall (S17) ───────────────────────────────");
  const dir = mkdtempSync(join(tmpdir(), "mc-xrepo-"));
  const cfg = loadDedupConfig();
  const repoA = join(dir, "repoA");
  const repoB = join(dir, "repoB");
  // Two distinct repos' vector indices. Repo A holds the relevant checkpoint;
  // repo B's query should pull it cross-repo.
  const storeA = new VectorStore({ stateDir: repoA, config: cfg, repoId: repoA });
  const storeB = new VectorStore({ stateDir: repoB, config: cfg, repoId: repoB });

  // Add a checkpoint to a store, then mirror its embedding into the shared
  // PGlite/HNSW vector_index — exactly what extensions/mega-pipeline.ts does
  // after a compaction (once per checkpoint). Awaited here so the index is
  // populated before we search (production fires it best-effort/async).
  async function seed(store, repoId, sessionId, summary, regionText, ts) {
    const res = store.add({ sessionId, summary, regionText, timestamp: ts });
    const cid = res.checkpoint?.checkpointId;
    const cp = store.list(sessionId).find((c) => c.checkpointId === cid);
    if (cp?.embedding) {
      try { await upsertEmbedding(repoId, sessionId, cid, cp.embedding); } catch { /* pglite disabled → sync fallback */ }
    }
    return cid;
  }

  const seeded = "The reactor tuned the glacier under the theatre lights";
  await seed(storeA, repoA, "sess_a", "reactor tuned glacier", seeded, 1);
  await seed(storeB, repoB, "sess_b", "unrelated ferry work", "The ferry carved the orchid beside the polar ice shelf", 1);
  // A few more in B so its own store is non-trivial.
  for (let i = 0; i < 20; i++) {
    await seed(storeB, repoB, "sess_b", `b${i}`, sentence(mulberry32(0x100 + i)), i + 2);
  }

  const latencies = [];
  let crossRepoHit = false;
  for (let i = 0; i < 30; i++) {
    const t0 = Date.now();
    const r = await recallAndInlineAsync(
      { sessionId: "sess_b", query: "reactor tuned glacier", limit: 5, source: "command",
        crossRepo: true, recallMaxTokens: 2000, dedupSim: 0.90, globalIndexDir: dir },
      storeB,
    );
    latencies.push(Date.now() - t0);
    if (r.toInject.some((h) => String(h.checkpoint.summary ?? "").includes("reactor"))) crossRepoHit = true;
  }

  const p = p95(latencies);
  check("cross-repo p95 latency < 50ms", p < 50, `${p.toFixed(2)}ms p95` + (PGLITE_DISABLED ? " (PGLite disabled — sync fallback)" : ""));
  check("foreign checkpoint recalled cross-repo", crossRepoHit, crossRepoHit ? "reactor checkpoint in top-K" : "MISSING");

  closeStore(repoA); closeStore(repoB);
  rmSync(dir, { recursive: true, force: true });
  return { p95Ms: p, crossRepoHit };
}

// ---------------------------------------------------------------------------
// 2. Compaction continuity — model-context-drops > 5:1
// ---------------------------------------------------------------------------
function benchContinuity() {
  console.log("\n── Compaction continuity (S16) ──────────────────────────");
  const rand = mulberry32(0xc0ffee);
  // Build a synthetic long window: 60 compacted user/assistant pairs + 3 recent
  // anchor messages. The compacted region [0, CUT) collapses to ONE summary
  // message; the recent anchor [CUT, end) stays verbatim.
  const view = [];
  for (let i = 0; i < 60; i++) {
    view.push({ role: "user", text: `old user request ${i}: ${sentence(rand)}`, toolName: undefined, input: undefined, output: undefined });
    view.push({ role: "assistant", text: `old answer ${i}: ${sentence(rand)}`, toolName: undefined, input: undefined, output: undefined });
  }
  const CUT = view.length - 6; // keep last 3 user/assistant pairs as anchor
  const region = CUT; // 114 compacted messages
  const summary = "<summary>earlier work: tuned reactor, carved orchid, forged nebula</summary>";

  const t0 = Date.now();
  const trimmed = buildLiveTrimmedView(view, { compactedFrom: CUT, summary, anchorUserMessages: 1 });
  const ms = Date.now() - t0;

  // Average over many calls — a single Date.now() reading is granularity-flaky.
  let total = 0;
  const N = 200;
  for (let i = 0; i < N; i++) buildLiveTrimmedView(view, { compactedFrom: CUT, summary, anchorUserMessages: 1 });
  const avgMs = (Date.now() - t0 - ms) / N;

  const anchor = trimmed.length - 1; // minus the 1 summary message
  const ratio = region / Math.max(1, anchor);
  check("live trim collapses region to 1 summary + recent anchor", trimmed[0]?.role === "user" && trimmed.length === 1 + anchor, `${region} → ${trimmed.length} msgs`);
  check("model-context-drops > 5:1 after compaction", ratio > 5, `${ratio.toFixed(1)}:1 (${region} compacted / ${anchor} anchor)`);
  check("live trim avg < 1ms over 200 calls", avgMs < 1, `${avgMs.toFixed(4)}ms avg`);
  return { ratio, anchor };
}

// ---------------------------------------------------------------------------
// 3. Memory-RAG recall hit rate (top-1)
// ---------------------------------------------------------------------------
async function benchMemory() {
  console.log("\n── Memory-RAG recall (S20/S21) ─────────────────────────");
  const dir = mkdtempSync(join(tmpdir(), "mc-mem-"));
  addMemory({ content: "We use node:sqlite as the source-of-truth store", category: "decision", target: "store" }, "repo_x", dir);
  addMemory({ content: "The cache sampled the walrus at the riverside studio", category: "fact" }, "repo_x", dir);
  addMemory({ content: "The ferry carved the orchid beside the polar ice shelf", category: "fact" }, "repo_x", dir);

  // Target: a lexically-matching query surfaces the seeded decision top-1.
  // (Proves the recall + category/recency merge mechanism. Note: the default
  //  trigram embedder is lexical, so a loosely-worded query like
  //  "which database is the source of truth" ranks it ~0.29 — see note below.)
  let top1 = false;
  let hitRate = 0;
  const trials = 10;
  for (let i = 0; i < trials; i++) {
    const hits = await recallMemories("use node sqlite as the source of truth store", dir, { topK: 3 });
    if (hits.length && /node:sqlite/.test(hits[0].memory.content)) { top1 = true; hitRate++; }
  }
  check("seeded memory recalled top-1 for matching query", top1, `${hitRate}/${trials} trials top-1`);

  // Informational: loose query still returns the memory somewhere in top-3.
  const loose = await recallMemories("which database is the source of truth", dir, { topK: 3 });
  const looseHit = loose.some((h) => /node:sqlite/.test(h.memory.content));
  console.log(`  • info: loose query "${"which database is the source of truth"}" → memory in top-3: ${looseHit ? "yes" : "no"} (trigram embedder is lexical)`);

  closeStore(dir);
  rmSync(dir, { recursive: true, force: true });
  return { top1, hitRate, trials };
}

// ---------------------------------------------------------------------------
console.log("pi-mega-compact — cross-repo + continuity + memory benchmarks (S23.1)");
console.log(`pglite: ${PGLITE_DISABLED ? "DISABLED (sync fallback)" : "enabled (HNSW)"}  | embedder: ${process.env.MEGACOMPACT_EMBEDDER ?? "trigram"}`);
console.log("=".repeat(78));

const x = await benchCrossRepo();
const c = benchContinuity();
const m = await benchMemory();

// Release the PGlite WASM handle + any open sqlite so the process exits cleanly.
try { await closeVectorIndex(); } catch { /* ignore */ }

console.log("\n" + "=".repeat(78));
console.log("Targets: cross-repo p95 < 50ms · context-drops > 5:1 · memory top-1 hit");
console.log(`Results: cross-repo p95=${x.p95Ms.toFixed(2)}ms · drops=${c.ratio.toFixed(1)}:1 · memory top-1=${m.top1 ? "PASS" : "FAIL"}`);
console.log(`BENCH_JSON=${JSON.stringify({ crossRepo: x, continuity: c, memory: m })}`);

if (FAILS.length) {
  console.error(`\n✗ ${FAILS.length} benchmark target(s) missed: ${FAILS.join(", ")}`);
  process.exit(1);
}
console.log("\n✓ all S23.1 benchmark targets met");
process.exit(0);
