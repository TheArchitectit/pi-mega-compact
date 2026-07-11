import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import { recallAndInline, formatRecallBlock } from "./recall.js";
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

test("recallAndInline empty when store has nothing for query", () => {
  const s = store();
  const r = recallAndInline({ sessionId: SESS, query: "no such topic exists here", limit: 5, source: "command" }, s as any);
  assert.equal(r.empty, true);
  assert.equal(r.block, "");
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
