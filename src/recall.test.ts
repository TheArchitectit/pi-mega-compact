import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import { recallAndInline, recallAndInlineAsync, formatRecallBlock } from "./recall.js";
import { markInjectedGlobal, wasInjectedGlobal, closeIndexStore } from "./store/sqlite.js";
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

test("S18: global injected-set skips a foreign checkpoint already injected machine-wide", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "mc-gi-"));
  try {
    const sess = "sess_cross";
    // A foreign checkpoint already marked injected globally (in this session).
    markInjectedGlobal("chkpt_foreign", "/repo/other", sess, indexDir);
    assert.equal(wasInjectedGlobal("chkpt_foreign", sess, indexDir), true);
    // searchAsync returns the foreign hit; recallAndInlineAsync must skip it
    // (globally injected) → toInject is empty.
    const mockStore = {
      searchAsync: async () => [{
        checkpoint: { checkpointId: "chkpt_foreign", summary: "foreign work", filesModified: [], dedupStatus: "active" },
        score: 0.92,
        repoId: "/repo/other",
      }],
      wasInjected: () => false,
      markInjected: () => {},
    } as any;
    const r = await recallAndInlineAsync(
      { sessionId: sess, query: "foreign", limit: 3, source: "command", crossRepo: true, globalIndexDir: indexDir },
      mockStore,
    );
    assert.equal(r.toInject.length, 0, "globally-injected foreign checkpoint skipped");
  } finally {
    closeIndexStore();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("S18: a fresh foreign checkpoint is injected AND recorded globally", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "mc-gi2-"));
  try {
    const sess = "sess_fresh";
    assert.equal(wasInjectedGlobal("chkpt_new", sess, indexDir), false);
    const mockStore = {
      searchAsync: async () => [{
        checkpoint: { checkpointId: "chkpt_new", summary: "brand new foreign work", filesModified: [], dedupStatus: "active" },
        score: 0.93,
        repoId: "/repo/alpha",
      }],
      wasInjected: () => false,
      markInjected: () => {},
    } as any;
    const r = await recallAndInlineAsync(
      { sessionId: sess, query: "foreign", limit: 3, source: "command", crossRepo: true, globalIndexDir: indexDir },
      mockStore,
    );
    assert.equal(r.toInject.length, 1, "fresh foreign checkpoint injected");
    assert.equal(wasInjectedGlobal("chkpt_new", sess, indexDir), true, "recorded machine-wide");
  } finally {
    closeIndexStore();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
