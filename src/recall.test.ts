import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import { recallAndInline, recallAndInlineAsync, formatRecallBlock } from "./recall.js";
import { vectorList } from "./vectorStore.js";
import { markInjectedGlobal, wasInjectedGlobal, closeIndexStore } from "./store/sqlite.js";
import {
  closeVectorIndex,
  initVectorIndex,
  rebuildFromSqlite,
} from "./store/vectorIndex.js";
import type { EngineMessage } from "./types.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-recall-"));
let counter = 0;
function store() {
  return new VectorStore({ dedupSim: 0.9, stateDir: join(baseTmp, `run-${counter++}`) });
}
function msg(role: EngineMessage["role"], text: string, toolName?: string): EngineMessage {
  return toolName ? { role, text, toolName, input: text, output: text } : { role, text };
}
const SESS = "sess_recall";

test("recallAndInline injects new hits and marks them injected", () => {
  const s = store();
  compactSession({ sessionId: SESS, messages: [msg("user", "investigated src/vectorStore.ts embedding"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "fixed the dedupe race in store.ts"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 2 }, s);

  const r1 = recallAndInline({ sessionId: SESS, query: "vectorStore embedding", limit: 1, source: "command" }, s as any);
  assert.equal(r1.empty, false);
  assert.equal(r1.toInject.length, 1);
  assert.ok(r1.block.includes("Recalled context"));

  // Second call with the same query must NOT re-inject (shared dedup).
  const r2 = recallAndInline({ sessionId: SESS, query: "vectorStore embedding", limit: 1, source: "command" }, s as any);
  assert.equal(r2.empty, true);
  assert.equal(r2.toInject.length, 0);
});

test("recallAndInline skipInjected=false re-returns hits", () => {
  const s = store();
  compactSession({ sessionId: SESS, messages: [msg("user", "configured the fast gate threshold"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  const r1 = recallAndInline({ sessionId: SESS, query: "fast gate threshold", limit: 5, source: "resume" }, s as any);
  const r2 = recallAndInline({ sessionId: SESS, query: "fast gate threshold", limit: 5, source: "resume", skipInjected: false }, s as any);
  assert.equal(r1.toInject.length, 1);
  assert.equal(r2.toInject.length, 1);
});

test("formatRecallBlock is empty for no hits", () => {
  assert.equal(formatRecallBlock([]), "");
});

test("formatRecallBlock (S17): labels a cross-repo hit with its source repo", () => {
  const hit = {
    checkpoint: { checkpointId: "chkpt_x", summary: "did thing Y", filesModified: ["a.ts"] },
    score: 0.91,
    repoId: "/home/u/rad-gateway",
  } as any;
  const block = formatRecallBlock([hit]);
  assert.ok(block.includes("from repo"), "labels cross-repo source");
  assert.ok(block.includes("rad-gateway"), "includes the repo display name");
});

test("formatRecallBlock (S17): omits the label for same-repo hits (no repoId)", () => {
  const hit = {
    checkpoint: { checkpointId: "c1", summary: "s", filesModified: [] },
    score: 0.9,
  } as any;
  const block = formatRecallBlock([hit]);
  assert.ok(!block.includes("from repo"), "no source label for same-repo hits");
});

test("recallAndInline empty when store has nothing for query", () => {
  const s = store();
  const r = recallAndInline({ sessionId: SESS, query: "no such topic exists here", limit: 5, source: "command" }, s as any);
  assert.equal(r.empty, true);
  assert.equal(r.block, "");
});

test("Fix C: recallMaxTokens caps the injected block", () => {
  const s = store();
  // Three distinct checkpoints so we can observe the cap bite mid-stream.
  compactSession({ sessionId: SESS, messages: [msg("user", "alpha module wiring and bootstrap sequence"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "beta module config and env resolution"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 2 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "gamma module shutdown and cleanup hooks"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 3 }, s);

  // A ceiling of 100 tokens fits the first checkpoint (~82) but stops before the
  // second (~163 cumulative) — proving the cap bites mid-stream.
  const r = recallAndInline(
    { sessionId: SESS, query: "module wiring config shutdown", limit: 5, source: "command", recallMaxTokens: 100, skipInjected: false },
    s as any,
  );
  assert.ok(r.toInject.length >= 1, "at least one injected under the cap");
  assert.ok(r.toInject.length < 3, "cap prevented all three from injecting");
  assert.ok(r.block.length > 0, "block non-empty");
});

test("Fix C: inline dedupe drops a hit already resident in the live window", () => {
  const s = store();
  const resident = "alpha module wiring and bootstrap sequence";
  compactSession({ sessionId: SESS, messages: [msg("user", resident), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "omega module telemetry and tracing spans"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 2 }, s);

  // Baseline: with dedupe OFF, both checkpoints are candidates.
  const rNoDedup = recallAndInline(
    { sessionId: SESS, query: "module wiring telemetry", limit: 5, source: "command", skipInjected: false },
    s as any,
  );
  // The live window contains the exact summary of the first checkpoint — as it
  // would be if a prior recall already injected it. Inline dedupe must drop it
  // (strictly fewer injected than the no-dedupe baseline).
  const residentSummary = rNoDedup.toInject[0].checkpoint.summary;
  const rDedup = recallAndInline(
    { sessionId: SESS, query: "module wiring telemetry", limit: 5, source: "command", skipInjected: false, windowDedupe: true, liveWindow: [residentSummary], dedupSim: 0.9 },
    s as any,
  );
  assert.ok(rDedup.toInject.length <= rNoDedup.toInject.length, "dedupe never adds hits");
  assert.ok(
    rDedup.toInject.length < rNoDedup.toInject.length,
    "inline dedupe dropped a resident hit",
  );
});

// ---- S18 cross-repo global injected-set (real-data, no mocks) ----------------
//
// Earlier versions of these tests used `as any` mock stores with canned
// `searchAsync` returns. That was mock data: it asserted recall's orchestration
// against a fake search result, not the real embed → HNSW → hydrate → inject
// path. Per the no-mock-data principle, both tests now seed a REAL foreign
// VectorStore (real checkpoint + real TrigramEmbedder embedding persisted to
// SQLite), rebuild the real PGlite index from it via `rebuildFromSqlite`, and
// run the full `recallAndInlineAsync` cross-repo path against a separate self
// store. The foreign checkpoint hydrates from the foreign store via its real
// repoId (== stateDir, per VectorStore's repoId convention).

async function seedForeignRepo(foreignStateDir: string): Promise<{ sessionId: string; checkpointId: string; summary: string }> {
  // A real VectorStore at the foreign repo's stateDir. repoId == stateDir.
  const foreign = new VectorStore({ stateDir: foreignStateDir, dedupSim: 0.9 });
  const sess = "sess_foreign";
  // Seed a real checkpoint via the real compactSession pipeline. The summary
  // text determines the embedding; the query below must land near it.
  const summary = "foreign repo authentication jwt token validation";
  const result = compactSession(
    {
      sessionId: sess,
      messages: [msg("user", summary), msg("assistant", "ok", "Edit")],
      keepFrom: 2,
      timestamp: 1,
    },
    foreign,
  );
  return { sessionId: sess, checkpointId: result.checkpointId ?? "", summary };
}

test("S18: global injected-set skips a foreign checkpoint already injected machine-wide", async () => {
  if (process.env.MEGACOMPACT_PGLITE_DISABLED === "true") { return; } // skip when WASM index is off
  const indexDir = mkdtempSync(join(tmpdir(), "mc-gi-"));
  const foreignStateDir = mkdtempSync(join(tmpdir(), "mc-gi-foreign-"));
  const selfStateDir = mkdtempSync(join(tmpdir(), "mc-gi-self-"));
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = mkdtempSync(join(tmpdir(), "mc-gi-vidx-"));
  try {
    await closeVectorIndex(); // fresh singleton per this index dir
    const seed = await seedForeignRepo(foreignStateDir);
    // Populate the real PGlite index from the foreign store's real checkpoints.
    await rebuildFromSqlite(
      () => [{ repoId: foreignStateDir, stateDir: foreignStateDir }],
      (sd) => {
        // readCheckpoints: yield (sessionId, checkpointId, embedding) for every
        // real checkpoint in this store. Mirrors the production enumerator.
        const store = new VectorStore({ stateDir: sd, dedupSim: 0.9 });
        return vectorList(store, seed.sessionId).map((cp) => ({
          sessionId: seed.sessionId,
          checkpointId: cp.checkpointId,
          embedding: cp.embedding,
        }));
      },
    );
    const pg = await initVectorIndex();
    assert.ok(pg, "PGlite index should initialize (WASM available)");

    const sess = "sess_cross";
    // Pre-mark the foreign checkpoint as already injected machine-wide.
    markInjectedGlobal(seed.checkpointId, foreignStateDir, sess, indexDir);
    assert.equal(wasInjectedGlobal(seed.checkpointId, sess, indexDir), true);

    // Self store (different repo) — the cross-repo query runs against the index.
    const selfStore = new VectorStore({ stateDir: selfStateDir, dedupSim: 0.9 });
    const r = await recallAndInlineAsync(
      { sessionId: sess, query: "foreign repo authentication jwt", limit: 3, source: "command", crossRepo: true, globalIndexDir: indexDir },
      selfStore,
    );
    assert.equal(r.toInject.length, 0, "globally-injected foreign checkpoint skipped");
  } finally {
    await closeVectorIndex();
    closeIndexStore();
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
    rmSync(indexDir, { recursive: true, force: true });
    rmSync(foreignStateDir, { recursive: true, force: true });
    rmSync(selfStateDir, { recursive: true, force: true });
  }
});

test("S18: a fresh foreign checkpoint is injected AND recorded globally", async () => {
  if (process.env.MEGACOMPACT_PGLITE_DISABLED === "true") { return; } // skip when WASM index is off
  const indexDir = mkdtempSync(join(tmpdir(), "mc-gi2-"));
  const foreignStateDir = mkdtempSync(join(tmpdir(), "mc-gi2-foreign-"));
  const selfStateDir = mkdtempSync(join(tmpdir(), "mc-gi2-self-"));
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = mkdtempSync(join(tmpdir(), "mc-gi2-vidx-"));
  try {
    await closeVectorIndex(); // fresh singleton per this index dir
    const seed = await seedForeignRepo(foreignStateDir);
    assert.equal(wasInjectedGlobal(seed.checkpointId, "sess_fresh", indexDir), false);
    await rebuildFromSqlite(
      () => [{ repoId: foreignStateDir, stateDir: foreignStateDir }],
      (sd) => {
        const store = new VectorStore({ stateDir: sd, dedupSim: 0.9 });
        return vectorList(store, seed.sessionId).map((cp) => ({
          sessionId: seed.sessionId,
          checkpointId: cp.checkpointId,
          embedding: cp.embedding,
        }));
      },
    );
    const pg = await initVectorIndex();
    assert.ok(pg, "PGlite index should initialize (WASM available)");

    const sess = "sess_fresh";
    const selfStore = new VectorStore({ stateDir: selfStateDir, dedupSim: 0.9 });
    const r = await recallAndInlineAsync(
      { sessionId: sess, query: "foreign repo authentication jwt", limit: 3, source: "command", crossRepo: true, globalIndexDir: indexDir },
      selfStore,
    );
    assert.equal(r.toInject.length, 1, "fresh foreign checkpoint injected");
    assert.equal(wasInjectedGlobal(seed.checkpointId, sess, indexDir), true, "recorded machine-wide");
  } finally {
    await closeVectorIndex();
    closeIndexStore();
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
    rmSync(indexDir, { recursive: true, force: true });
    rmSync(foreignStateDir, { recursive: true, force: true });
    rmSync(selfStateDir, { recursive: true, force: true });
  }
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
