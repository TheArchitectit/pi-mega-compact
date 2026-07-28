#!/usr/bin/env node
/**
 * cross-repo-e2e.mjs — S25-B headless two-repo driver.
 *
 * Proves the headline contract through the REAL production paths (no mocked
 * search): a decision/checkpoint recorded in repo A surfaces as RAG context
 * when a session starts in repo B — plus the kill-switch and corruption
 * fallback behavior.
 *
 * Phases:
 *   A  checkpoint recall on resume — repo A compacts a distinctive topic; a
 *      repo B `recallAndInlineAsync(crossRepo:true)` must surface it labeled
 *      "from repo …".
 *   B  memory augmentation — repo A `applyMemoryOps(add decision)`; repo B
 *      `recallMemoriesAndInline(crossRepo:true)` must surface it labeled
 *      "(from …)".
 *   C1 kill-switch — with MEGACOMPACT_PGLITE_DISABLED=1 both recall paths
 *      degrade to same-repo-only, no error.
 *   C2 corruption — a torn PGlite dir must self-heal (delete + retry) or
 *      disable gracefully; no crash ever (PREVENT-PI-004 / best-effort rule).
 *
 * Fully local, no network. Uses compiled dist/ — run `npm run build` first.
 * Non-repo temp dirs → repoKey() falls back to stateDir, so the two indexes
 * remain keyed consistently through the S25 unified scope (repoKey).
 *
 * Usage:  node scripts/cross-repo-e2e.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dsrc = join(root, "dist", "src");

// Isolation FIRST — env is read at module load / first open, so set before imports run.
const TMP = mkdtempSync(join(tmpdir(), "mc-xrepo-e2e-"));
const IDX = join(TMP, "index"); // MEGACOMPACT_INDEX_DIR (global injected-set + memory index dir parent)
const VIDX = join(TMP, "vector"); // MEGACOMPACT_VECTOR_INDEX_DIR (checkpoint index)
process.env.MEGACOMPACT_INDEX_DIR = IDX;
process.env.MEGACOMPACT_VECTOR_INDEX_DIR = VIDX;

const { VectorStore } = await import(join(dsrc, "vectorStore.js"));
const { compactSession } = await import(join(dsrc, "engine.js"));
const { recallAndInlineAsync, recallMemoriesAndInline } = await import(join(dsrc, "recall.js"));
const { applyMemoryOps } = await import(join(dsrc, "memoryOps.js"));
const { repoKey } = await import(join(dsrc, "store", "repoKey.js"));
const {
  upsertEmbedding,
  searchAsync,
  closeVectorIndex,
  isVectorIndexDisabled,
} = await import(join(dsrc, "store", "vectorIndex.js"));
const {
  upsertMemoryEmbedding,
  searchMemoriesAsync,
  closeMemoryIndex,
  isMemoryIndexDisabled,
} = await import(join(dsrc, "store", "memoryIndex.js"));
const { upsertRepoRegistry, closeIndexStore } = await import(join(dsrc, "store", "sqlite.js"));
const { defaultEmbedder } = await import(join(dsrc, "embedder.js"));
const { vectorList } = await import(join(dsrc, "vector-read.js"));

const FAILS = [];
function check(name, ok, detail) {
  if (ok) console.log(`  ✓ ${name}${detail ? "  (" + detail + ")" : ""}`);
  else { console.log(`  ✗ ${name}${detail ? "  (" + detail + ")" : ""}`); FAILS.push(name); }
}

const msg = (role, text) => ({ role, text });

/** Register repo in the machine-wide repo_registry (what bind-repo.ts does). */
function registerRepo(repoDir, stateDir) {
  upsertRepoRegistry({
    repoRoot: repoKey(stateDir),
    displayName: repoDir.split(/[\\/]/).pop(),
    stateDir,
    checkpointCount: 0,
    tokensSaved: 0,
    compressedOriginalBytes: 0,
  });
}

/** Drive repo A: real compactSession + production-equivalent index mirror. */
async function seedRepoA(stateDir) {
  const store = new VectorStore({ stateDir, dedupSim: 0.9 });
  const sid = "sess_a";
  const top = "circuit breaker retry policy in apiClient.ts — exponential backoff, half-open probe every 30s";
  const res = compactSession(
    { sessionId: sid, messages: [msg("user", top), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 },
    store,
  );
  const cps = vectorList(store, sid);
  const latest = cps.find((c) => c.checkpointId === res.checkpointId);
  if (!latest?.embedding) throw new Error("repo A checkpoint missing embedding");
  // Production mirror (extensions/mega-pipeline/compact.ts) — awaited here so
  // the index is populated before repo B searches (in prod it's fire-and-forget).
  await upsertEmbedding(repoKey(stateDir), sid, latest.checkpointId, latest.embedding);
  return { store, sid, checkpointId: latest.checkpointId, topic: top };
}

async function main() {
  console.log("\n── S25-B cross-repo E2E ──────────────────────────────────");
  const repoAState = join(TMP, "repo-a", ".pi", "mega-compact");
  const repoBState = join(TMP, "repo-b", ".pi", "mega-compact");
  mkdirSync(repoAState, { recursive: true });
  mkdirSync(repoBState, { recursive: true });
  registerRepo(join(TMP, "repo-a"), repoAState);
  registerRepo(join(TMP, "repo-b"), repoBState);

  // ── Phase A: checkpoint recall across repos ─────────────────────────────
  console.log("\nPhase A — checkpoint recall on resume");
  const a = await seedRepoA(repoAState);
  const storeB = new VectorStore({ stateDir: repoBState, dedupSim: 0.9 });
  const r = await recallAndInlineAsync(
    { sessionId: "sess_b", query: "circuit breaker retry policy apiClient", limit: 3,
      source: "command", crossRepo: true, globalIndexDir: IDX },
    storeB,
  );
  const block = r.block ?? "";
  check("repo A checkpoint recalled from repo B", block.includes("circuit breaker"), block.slice(0, 60).replace(/\n/g, " "));
  check("hit labeled cross-repo ('from repo')", /from repo /i.test(block));

  // ── Phase B: memory augmentation across repos ───────────────────────────
  console.log("\nPhase B — memory augmentation");
  applyMemoryOps([{ op: "add", memory: { content: "we standardized on node:sqlite for the store backend", category: "decision", sourceTurn: 0 } }], repoAState);
  // applyMemoryOps's index mirror is fire-and-forget (void) in production; the
  // driver awaits an explicit, deterministic upsert with the SAME scope key so
  // the recall assertion is not racy.
  await upsertMemoryEmbedding(repoKey(repoAState), 1, "we standardized on node:sqlite for the store backend", defaultEmbedder().embed("we standardized on node:sqlite for the store backend"));
  const mr = await recallMemoriesAndInline({
    stateDir: repoBState, query: "what store backend do we use?", limit: 3,
    crossRepo: true, recallMaxTokens: 2000, source: "session_start",
  });
  check("repo A memory augmented into repo B", !mr.empty && /node:sqlite/.test(mr.block));
  check("memory labeled cross-repo ('from <repo>' in block)", /\(relevance \d+% from [^)]+\)/.test(mr.block));

  // ── Phase C1: kill-switch degradation ───────────────────────────────────
  console.log("\nPhase C1 — MEGACOMPACT_PGLITE_DISABLED kill-switch");
  await closeVectorIndex();
  await closeMemoryIndex();
  process.env.MEGACOMPACT_PGLITE_DISABLED = "1";
  const hits = await searchAsync(defaultEmbedder().embed("circuit breaker retry"), { k: 3 });
  const mHits = await searchMemoriesAsync(defaultEmbedder().embed("store backend"), { k: 3 });
  check("searchAsync returns [] under kill-switch", hits.length === 0);
  check("searchMemoriesAsync returns [] under kill-switch", mHits.length === 0);
  check("both indexes report disabled", isVectorIndexDisabled() && isMemoryIndexDisabled());
  const rC1 = await recallAndInlineAsync(
    { sessionId: "sess_c1", query: "circuit breaker retry policy apiClient", limit: 3,
      source: "command", crossRepo: true, globalIndexDir: IDX },
    new VectorStore({ stateDir: repoBState, dedupSim: 0.9 }),
  );
  check("recall degrades same-repo-only (no cross-repo label), no error", !/from repo /i.test(rC1.block ?? ""));
  delete process.env.MEGACOMPACT_PGLITE_DISABLED;

  // ── Phase C2: torn PGlite dir self-heal / graceful disable ──────────────
  console.log("\nPhase C2 — corrupt index dir");
  await closeVectorIndex();
  await closeMemoryIndex();
  rmSync(VIDX, { recursive: true, force: true });
  mkdirSync(VIDX, { recursive: true });
  writeFileSync(join(VIDX, "data"), Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef])); // torn garbage
  let threw = false;
  try {
    const q = defaultEmbedder().embed("circuit breaker retry policy");
    await searchAsync(q, { k: 3 }); // must self-heal OR degrade — never throw
  } catch (e) {
    threw = true;
    console.log(`    unexpected throw: ${e.message}`);
  }
  check("corrupt dir handled without crash", !threw);

  // ── Cleanup + verdict ───────────────────────────────────────────────────
  await closeVectorIndex();
  await closeMemoryIndex();
  closeIndexStore();
  try { a.store?.close?.(); } catch { /* optional */ }
  try { storeB?.close?.(); } catch { /* optional */ }
  rmSync(TMP, { recursive: true, force: true });

  console.log("");
  if (FAILS.length) {
    console.error(`FAILED: ${FAILS.join(", ")}`);
    process.exit(1);
  }
  console.log("cross-repo E2E: ALL PHASES GREEN");
}

main().catch((e) => {
  console.error("driver crashed:", e);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
