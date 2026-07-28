import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import { recallAndInline, recallAndInlineAsync, formatRecallBlock } from "./recall.js";
import { vectorList, vectorWasInjected } from "./vectorStore.js";
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

  // A ceiling of 50 tokens fits the first checkpoint (~33 body tokens) but
  // stops before the second (~65 cumulative) — proving the cap bites mid-stream.
  // (F3: the cap now counts body tokens only — one preamble at format time, not
  // N — matching the async path. The old per-hit preamble counting needed ~100.)
  const r = recallAndInline(
    { sessionId: SESS, query: "module wiring config shutdown", limit: 5, source: "command", recallMaxTokens: 50, skipInjected: false },
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

// ---- F3: format-once — one preamble, [1..n] numbering, cap respected ----
//
// The fix (landed async, extended to sync here) accumulates the hit list and
// calls formatRecallBlock ONCE at the end, so a multi-hit block carries exactly
// one preamble and contiguous [1..n] labels instead of one preamble per hit.

test("F3 (sync): multi-hit injection has exactly one preamble and [1..n] numbering", () => {
  const s = store();
  compactSession({ sessionId: SESS, messages: [msg("user", "alpha module wiring and bootstrap sequence"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "beta module config and env resolution"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 2 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "gamma module shutdown and cleanup hooks"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 3 }, s);

  const r = recallAndInline(
    { sessionId: SESS, query: "module wiring config shutdown", limit: 5, source: "command", skipInjected: false },
    s as any,
  );
  assert.ok(r.toInject.length >= 2, "at least two hits injected (got " + r.toInject.length + ")");
  // Exactly one preamble (the old per-hit format produced one per hit).
  const preamble = "The following compacted context was recalled";
  assert.equal(r.block.split(preamble).length - 1, 1, "exactly one preamble for a multi-hit block");
  // Contiguous [1..n] numbering.
  for (let i = 1; i <= r.toInject.length; i++) {
    assert.ok(r.block.includes(`[${i}]`), `block includes [${i}]`);
  }
  // No out-of-range label (e.g. [n+1]) leaks in.
  assert.ok(!r.block.includes(`[${r.toInject.length + 1}]`), "no extra-numbered label");
});

test("F3 (sync): recallMaxTokens caps mid-stream with exactly one preamble", () => {
  const s = store();
  compactSession({ sessionId: SESS, messages: [msg("user", "alpha module wiring and bootstrap sequence"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "beta module config and env resolution"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 2 }, s);
  compactSession({ sessionId: SESS, messages: [msg("user", "gamma module shutdown and cleanup hooks"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 3 }, s);

  // A tight ceiling that fits the first checkpoint (~33 body tokens) but stops
  // before the second (~65 cumulative). F3: body-only counting (one preamble at
  // format time, not per hit), matching the async path.
  const r = recallAndInline(
    { sessionId: SESS, query: "module wiring config shutdown", limit: 5, source: "command", skipInjected: false, recallMaxTokens: 50 },
    s as any,
  );
  assert.ok(r.toInject.length < 3, "cap stopped before all three injected");
  assert.ok(r.toInject.length >= 1, "at least one injected under the cap");
  assert.equal(
    r.block.split("The following compacted context was recalled").length - 1,
    1,
    "still exactly one preamble under the cap",
  );
});

test("F3 (async): multi-hit cross-repo injection has exactly one preamble and [1..n] numbering", async () => {
  if (process.env.MEGACOMPACT_PGLITE_DISABLED === "true") { return; } // skip when WASM index is off
  const indexDir = mkdtempSync(join(tmpdir(), "mc-f3a-"));
  const foreignStateDir = mkdtempSync(join(tmpdir(), "mc-f3a-foreign-"));
  const selfStateDir = mkdtempSync(join(tmpdir(), "mc-f3a-self-"));
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = mkdtempSync(join(tmpdir(), "mc-f3a-vidx-"));
  try {
    await closeVectorIndex();
    // Seed multiple distinct foreign checkpoints so the cross-repo query yields
    // more than one hit (needed to assert [1..n] numbering).
    const foreign = new VectorStore({ stateDir: foreignStateDir, dedupSim: 0.9 });
    const fsess = "sess_foreign_f3";
    const summaries = [
      "foreign repo authentication jwt token validation",
      "foreign repo database connection pooling and retry",
      "foreign repo logging telemetry and tracing spans",
    ];
    const cids: string[] = [];
    for (let i = 0; i < summaries.length; i++) {
      const res = compactSession(
        { sessionId: fsess, messages: [msg("user", summaries[i]), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: i + 1 },
        foreign,
      );
      if (res.checkpointId) cids.push(res.checkpointId);
    }
    await rebuildFromSqlite(
      () => [{ repoId: foreignStateDir, stateDir: foreignStateDir }],
      (sd) => {
        const st = new VectorStore({ stateDir: sd, dedupSim: 0.9 });
        return vectorList(st, fsess).map((cp) => ({
          sessionId: fsess, checkpointId: cp.checkpointId, embedding: cp.embedding,
        }));
      },
    );
    const pg = await initVectorIndex();
    assert.ok(pg, "PGlite index should initialize");

    const selfStore = new VectorStore({ stateDir: selfStateDir, dedupSim: 0.9 });
    const r = await recallAndInlineAsync(
      { sessionId: "sess_f3", query: "foreign repo", limit: 5, source: "command", crossRepo: true, skipInjected: false, globalIndexDir: indexDir },
      selfStore,
    );
    assert.ok(r.toInject.length >= 2, "at least two cross-repo hits (got " + r.toInject.length + ")");
    assert.equal(
      r.block.split("The following compacted context was recalled").length - 1,
      1,
      "exactly one preamble for a multi-hit async block",
    );
    for (let i = 1; i <= r.toInject.length; i++) {
      assert.ok(r.block.includes(`[${i}]`), `async block includes [${i}]`);
    }
    assert.ok(!r.block.includes(`[${r.toInject.length + 1}]`), "no extra-numbered label (async)");
  } finally {
    await closeVectorIndex();
    closeIndexStore();
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
    rmSync(indexDir, { recursive: true, force: true });
    rmSync(foreignStateDir, { recursive: true, force: true });
    rmSync(selfStateDir, { recursive: true, force: true });
  }
});

// ---- F2: cross-repo injected-set bypass ----------------------------------
//
// When the same session resumes in a DIFFERENT repo, the per-repo session_state
// has no injection marker for the foreign checkpoint (different stateDir), so
// only the machine-wide injected-set (shared globalIndexDir) can block a
// re-inject. The F2 fix ensures globalIndexDir is always resolved (via
// getIndexDir in the extension), so wasInjectedGlobal is consulted; without
// the fix, globalIndexDir was undefined and foreign checkpoints re-injected
// every resume. This test passes globalIndexDir explicitly (simulating the
// resolver default) and does NOT set MEGACOMPACT_INDEX_DIR.

test("F2: cross-repo hit is not re-injected when resuming the same session in a different repo (shared index dir)", async () => {
  if (process.env.MEGACOMPACT_PGLITE_DISABLED === "true") { return; } // skip when WASM index is off
  const indexDir = mkdtempSync(join(tmpdir(), "mc-f2-"));
  const foreignStateDir = mkdtempSync(join(tmpdir(), "mc-f2-foreign-"));
  const selfStateDir1 = mkdtempSync(join(tmpdir(), "mc-f2-self1-"));
  const selfStateDir2 = mkdtempSync(join(tmpdir(), "mc-f2-self2-"));
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = mkdtempSync(join(tmpdir(), "mc-f2-vidx-"));
  try {
    await closeVectorIndex();
    const seed = await seedForeignRepo(foreignStateDir);
    await rebuildFromSqlite(
      () => [{ repoId: foreignStateDir, stateDir: foreignStateDir }],
      (sd) => {
        const st = new VectorStore({ stateDir: sd, dedupSim: 0.9 });
        return vectorList(st, seed.sessionId).map((cp) => ({
          sessionId: seed.sessionId, checkpointId: cp.checkpointId, embedding: cp.embedding,
        }));
      },
    );
    const pg = await initVectorIndex();
    assert.ok(pg, "PGlite index should initialize");

    const sess = "sess_resume";
    // Repo B: first recall — fresh foreign checkpoint is injected AND recorded
    // in the shared machine-wide index.
    const storeB = new VectorStore({ stateDir: selfStateDir1, dedupSim: 0.9 });
    const r1 = await recallAndInlineAsync(
      { sessionId: sess, query: "foreign repo authentication jwt", limit: 3, source: "command", crossRepo: true, globalIndexDir: indexDir },
      storeB,
    );
    assert.equal(r1.toInject.length, 1, "first recall (repo B) injects the foreign checkpoint");
    assert.equal(wasInjectedGlobal(seed.checkpointId, sess, indexDir), true, "recorded in the shared index");

    // Repo C: SAME session resumed in a DIFFERENT repo. The per-session injected
    // set in repo C's store is empty (different stateDir), so only the shared
    // global injected-set can block re-injection.
    const storeC = new VectorStore({ stateDir: selfStateDir2, dedupSim: 0.9 });
    assert.equal(vectorWasInjected(storeC, sess, seed.checkpointId), false, "repo C per-session set is empty (different stateDir)");
    const r2 = await recallAndInlineAsync(
      { sessionId: sess, query: "foreign repo authentication jwt", limit: 3, source: "command", crossRepo: true, globalIndexDir: indexDir },
      storeC,
    );
    assert.equal(r2.toInject.length, 0, "second recall (repo C) does NOT re-inject (machine-wide global dedup)");
  } finally {
    await closeVectorIndex();
    closeIndexStore();
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
    rmSync(indexDir, { recursive: true, force: true });
    rmSync(foreignStateDir, { recursive: true, force: true });
    rmSync(selfStateDir1, { recursive: true, force: true });
    rmSync(selfStateDir2, { recursive: true, force: true });
  }
});

test("F2: without globalIndexDir, cross-repo hits are skipped (not injected undeduped)", async () => {
  if (process.env.MEGACOMPACT_PGLITE_DISABLED === "true") { return; } // skip when WASM index is off
  const foreignStateDir = mkdtempSync(join(tmpdir(), "mc-f2b-foreign-"));
  const selfStateDir = mkdtempSync(join(tmpdir(), "mc-f2b-self-"));
  process.env.MEGACOMPACT_VECTOR_INDEX_DIR = mkdtempSync(join(tmpdir(), "mc-f2b-vidx-"));
  try {
    await closeVectorIndex();
    const seed = await seedForeignRepo(foreignStateDir);
    await rebuildFromSqlite(
      () => [{ repoId: foreignStateDir, stateDir: foreignStateDir }],
      (sd) => {
        const st = new VectorStore({ stateDir: sd, dedupSim: 0.9 });
        return vectorList(st, seed.sessionId).map((cp) => ({
          sessionId: seed.sessionId, checkpointId: cp.checkpointId, embedding: cp.embedding,
        }));
      },
    );
    const pg = await initVectorIndex();
    assert.ok(pg, "PGlite index should initialize");

    // No globalIndexDir → the F2 guard skips foreign hits rather than injecting
    // them undeduped. Same-repo hits (none here) would still pass.
    const selfStore = new VectorStore({ stateDir: selfStateDir, dedupSim: 0.9 });
    const r = await recallAndInlineAsync(
      { sessionId: "sess_nodir", query: "foreign repo authentication jwt", limit: 3, source: "command", crossRepo: true },
      selfStore,
    );
    assert.equal(r.toInject.length, 0, "foreign hit skipped when globalIndexDir is unset (no undeduped injection)");
  } finally {
    await closeVectorIndex();
    closeIndexStore();
    delete process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
    rmSync(foreignStateDir, { recursive: true, force: true });
    rmSync(selfStateDir, { recursive: true, force: true });
  }
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
