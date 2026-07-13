import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession, recall, mergeSummary, supersededCount } from "./engine.js";
import type { EngineMessage } from "./types.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-engine-"));
let counter = 0;
function store() {
  return new VectorStore({ dedupSim: 0.9, stateDir: join(baseTmp, `run-${counter++}`) });
}

const SESS = "sess_engine";

function msg(role: EngineMessage["role"], text: string, toolName?: string): EngineMessage {
  return toolName ? { role, text, toolName, input: text, output: text } : { role, text };
}

test("compactSession supersedes then persists a checkpoint", () => {
  const s = store();
  const messages: EngineMessage[] = [
    msg("user", "read src/server.ts"),
    msg("assistant", "ok", "Read"),
    msg("user", "edit src/server.ts"),
    msg("assistant", "ok", "Edit"),
    msg("user", "now fix the bug in src/server.ts"),
    msg("assistant", "done", "Edit"),
  ];
  const r = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 1 }, s);
  assert.equal(r.skipped, false);
  assert.equal(r.deduped, false);
  assert.match(r.checkpointId ?? "", /^chkpt_001$/);
  assert.ok(r.summary.length > 0, "summary produced by COLLAPSE");
  assert.ok(r.regionHash.length > 0);
  // SUPERSEDE dropped the obsolete first read turn (user read @0 superseded by
  // the edit @2) — so exactly one superseded message in the compacted slice.
  assert.equal(supersededCount(messages.slice(0, 4)), 1);
  assert.equal(r.compactedFrom, 4);
  // The persisted checkpoint is searchable.
  assert.equal(s.search(SESS, "bug src/server.ts", 5).length, 1);
});

test("compactSession is idempotent on identical region (dedup sentinel)", () => {
  const s = store();
  const messages: EngineMessage[] = [
    msg("user", "alpha work on the parser"),
    msg("assistant", "did it", "Edit"),
    msg("user", "beta work on the renderer"),
    msg("assistant", "done", "Edit"),
  ];
  const r1 = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 1 }, s);
  const r2 = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 2 }, s);
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r1.checkpointId, r2.checkpointId);
  assert.equal(s.search(SESS, "parser", 10).length, 1);
});

test("compactSession skipped when slice is empty", () => {
  const s = store();
  const r = compactSession({ sessionId: SESS, messages: [msg("user", "only tail")], keepFrom: 0 }, s);
  assert.equal(r.skipped, true);
  assert.equal(s.search(SESS, "x", 5).length, 0);
});

test("recall drops already-injected checkpoints", () => {
  const s = store();
  compactSession({ sessionId: SESS, messages: [msg("user", "investigated src/vectorStore.ts"), msg("assistant", "ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  const first = recall({ sessionId: SESS, query: "vectorStore", limit: 5, skipInjected: true }, s);
  assert.equal(first.newHits.length, 1);
  s.markInjected(SESS, first.hits[0].checkpoint.checkpointId);
  const second = recall({ sessionId: SESS, query: "vectorStore", limit: 5, skipInjected: true }, s);
  assert.equal(second.newHits.length, 0);
  // Without the skip flag, both hits still surface.
  assert.equal(second.hits.length, 1);
});

test("mergeSummary accumulates prior + new context", () => {
  const prior = "<summary>Conversation summary:\n- Key files referenced: src/a.ts.\n</summary>";
  const next = "<summary>Conversation summary:\n- Key files referenced: src/b.ts.\n</summary>";
  const merged = mergeSummary(prior, next);
  assert.ok(merged.includes("src/a.ts"));
  assert.ok(merged.includes("src/b.ts"));
  assert.ok(merged.includes("Newly compacted"));
});

test("supersededCount reports obsolete reads", () => {
  const messages: EngineMessage[] = [
    msg("user", "read src/x.ts"),
    msg("assistant", "ok", "Read"),
    msg("user", "write src/x.ts"),
    msg("assistant", "ok", "Edit"),
  ];
  assert.equal(supersededCount(messages), 1);
});

test("compactSession with useExtractive produces topicSummary on checkpoint", () => {
  const s = store();
  const messages: EngineMessage[] = [
    msg("user", "let's refactor the auth module in src/auth.ts"),
    msg("assistant", "I'll start by reading the current implementation", "Read"),
    msg("user", "extract the login logic into a separate function"),
    msg("assistant", "Extracted login() into src/auth.ts:45", "Edit"),
    msg("user", "now add the session token generation"),
    msg("assistant", "Added generateSessionToken in src/auth.ts:78", "Edit"),
  ];
  const r = compactSession({ sessionId: "sess_extr", messages, keepFrom: 4, timestamp: 1, useExtractiveSummary: true }, s);
  assert.equal(r.skipped, false);
  assert.ok(r.checkpointId, "checkpoint created");
  // The checkpoint should have topicSummary populated
  const hits = s.search("sess_extr", "auth refactor", 5);
  assert.ok(hits.length > 0);
  // topicSummary should be present on the stored checkpoint (via extractive path)
  assert.ok(hits[0].checkpoint.topicSummary, "topicSummary should be populated when useExtractive is true");
  assert.ok(hits[0].checkpoint.topicSummary!.length > 0);
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
