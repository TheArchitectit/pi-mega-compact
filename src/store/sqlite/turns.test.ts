/**
 * turns.test.ts — S43 per-turn + conversation tracking tests.
 *
 * No network. Real stores with temp state dirs.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./utils.js";
import {
  recordTurn,
  recordTurnRecall,
  getTurn,
  getTurnById,
  listTurnRecall,
  listConversationTurns,
  ensureConversationId,
  forkConversation,
  newConversationId,
  clearTurns,
} from "./turns.js";
import { loadSessionState, saveSessionState } from "./session-state.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mc-turns-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, `run-${counter++}`);
}

// ─── 1. recordTurn upserts + getTurn round-trip ────────────────────────────

test("S43-1: recordTurn inserts/updates + getTurn finds by conv+index", () => {
  const sd = stateDir();
  openStore(sd);
  const conv = newConversationId();
  const id = recordTurn({
    conversationId: conv,
    sessionId: "sess-1",
    turnIndex: 3,
    endedAt: 1000,
    ctxTokens: 12000,
    ctxPercent: 42.5,
    pressureBand: "mid",
    modelId: "claude-fable-5",
  }, sd);
  assert.ok(id > 0, "turn id returned");
  const t = getTurn(conv, 3, sd);
  assert.ok(t, "turn found");
  assert.equal(t!.conversationId, conv);
  assert.equal(t!.turnIndex, 3);
  assert.equal(t!.ctxTokens, 12000);
  assert.equal(t!.ctxPercent, 42.5);
  assert.equal(t!.pressureBand, "mid");
  assert.equal(t!.modelId, "claude-fable-5");
  assert.equal(t!.endedAt, 1000);
  // Re-record (upsert) with additional metrics — COALESCE preserves started_at.
  const id2 = recordTurn({
    conversationId: conv,
    sessionId: "sess-1",
    turnIndex: 3,
    startedAt: 900,
    ctxTokens: 12500,
  }, sd);
  assert.equal(id2, id, "same turn id on upsert");
  const t2 = getTurn(conv, 3, sd);
  assert.equal(t2!.ctxTokens, 12500, "metrics updated");
  assert.equal(t2!.startedAt, 900, "started_at set on second write");
});

// ─── 2. recordTurnRecall + listTurnRecall ───────────────────────────────────

test("S43-2: recordTurnRecall stores provenance + listTurnRecall returns it", () => {
  const sd = stateDir();
  openStore(sd);
  const conv = newConversationId();
  const turnId = recordTurn({
    conversationId: conv,
    sessionId: "sess-1",
    turnIndex: 1,
  }, sd);
  recordTurnRecall(turnId, [
    { checkpointId: "chkpt_003", score: 0.91, source: "flat" },
    { checkpointId: "r1_0", score: 0.78, source: "raptor", raptorLevel: 1 },
    { checkpointId: "chkpt_007", score: 0.65, source: "cross-repo" },
  ], sd);
  const recalls = listTurnRecall(turnId, sd);
  assert.equal(recalls.length, 3);
  assert.equal(recalls[0].checkpointId, "chkpt_003", "sorted by score desc");
  assert.equal(recalls[0].score, 0.91);
  const raptorHit = recalls.find((r) => r.source === "raptor");
  assert.ok(raptorHit, "raptor hit present");
  assert.equal(raptorHit!.raptorLevel, 1);
  assert.equal(raptorHit!.checkpointId, "r1_0");
  // Re-record with a changed score → upsert, no duplicate.
  recordTurnRecall(turnId, [{ checkpointId: "chkpt_003", score: 0.95, source: "flat" }], sd);
  const recalls2 = listTurnRecall(turnId, sd);
  assert.equal(recalls2.length, 3, "no duplicate on re-record");
  const updated = recalls2.find((r) => r.checkpointId === "chkpt_003");
  assert.equal(updated!.score, 0.95, "score updated");
});

// ─── 3. listConversationTurns ───────────────────────────────────────────────

test("S43-3: listConversationTurns returns turns in order", () => {
  const sd = stateDir();
  openStore(sd);
  const conv = newConversationId();
  for (let i = 1; i <= 4; i++) {
    recordTurn({
      conversationId: conv,
      sessionId: "sess-1",
      turnIndex: i,
      endedAt: i * 100,
    }, sd);
  }
  const turns = listConversationTurns(conv, sd);
  assert.equal(turns.length, 4);
  assert.deepEqual(turns.map((t) => t.turnIndex), [1, 2, 3, 4]);
});

// ─── 4. ensureConversationId persists + is stable across resumes ───────────

test("S43-4: ensureConversationId generates once, persists, survives reload", () => {
  const sd = stateDir();
  openStore(sd);
  const sid = "sess-resume";
  // First call generates + persists.
  const conv1 = ensureConversationId(sid, sd);
  assert.ok(conv1.startsWith("conv_"), "generated id has prefix");
  // Second call (simulated resume) returns the same id — reads session_state.
  const conv2 = ensureConversationId(sid, sd);
  assert.equal(conv2, conv1, "stable across resumes");
  // A different session gets a different conversation id.
  const conv3 = ensureConversationId("sess-other", sd);
  assert.notEqual(conv3, conv1);
});

// ─── 5. forkConversation records lineage + returns recall set ──────────────

test("S43-5: forkConversation creates child + returns parent's recall set", () => {
  const sd = stateDir();
  openStore(sd);
  const parent = newConversationId();
  // Parent conversation: turn 1 with 2 recalled checkpoints.
  const turnId = recordTurn({
    conversationId: parent,
    sessionId: "sess-parent",
    turnIndex: 1,
  }, sd);
  recordTurnRecall(turnId, [
    { checkpointId: "chkpt_001", score: 0.9, source: "flat" },
    { checkpointId: "chkpt_002", score: 0.7, source: "flat" },
  ], sd);
  // Fork at turn 1.
  const { conversationId: child, recalled } = forkConversation(parent, turnId, sd);
  assert.ok(child.startsWith("conv_"), "child is a conversation id");
  assert.notEqual(child, parent, "child differs from parent");
  assert.equal(recalled.length, 2, "parent's recall set returned for replay");
  assert.ok(
    recalled.some((r) => r.checkpointId === "chkpt_001"),
    "includes parent's recalled checkpoint",
  );
  // The child conversation is recorded as a branch.
  const branches = openStore(sd).prepare(
    "SELECT parent_conversation_id, fork_turn_id FROM conversation_branches WHERE conversation_id = ?",
  ).get(child) as { parent_conversation_id: string; fork_turn_id: number };
  assert.equal(branches.parent_conversation_id, parent);
  assert.equal(branches.fork_turn_id, turnId);
});

// ─── 6. clearTurns removes turns + their recall rows for a session ──────────

test("S43-6: clearTurns removes turns + cascade turn_recall", () => {
  const sd = stateDir();
  openStore(sd);
  const conv = newConversationId();
  const turnId = recordTurn({
    conversationId: conv,
    sessionId: "sess-clear",
    turnIndex: 1,
  }, sd);
  recordTurnRecall(turnId, [{ checkpointId: "x", score: 0.5, source: "flat" }], sd);
  assert.equal(listTurnRecall(turnId, sd).length, 1);
  clearTurns("sess-clear", sd);
  assert.equal(getTurnById(turnId, sd), null, "turn gone");
  assert.equal(listTurnRecall(turnId, sd).length, 0, "recall rows cascaded");
});

// ─── 7. conversation id survives across SessionState save/load ──────────────

test("S43-7: conversationId round-trips through SessionState", () => {
  const sd = stateDir();
  openStore(sd);
  const sid = "sess-rt";
  // Save a state with a conversationId.
  const conv = "conv_roundtrip";
  saveSessionState(sid, {
    injectedCheckpointIds: [],
    storedRegionHashes: [],
    conversationId: conv,
  }, sd);
  const loaded = loadSessionState(sid, sd);
  assert.equal(loaded.conversationId, conv, "conversationId persisted");
  // ensureConversationId picks up the existing one.
  assert.equal(ensureConversationId(sid, sd), conv, "ensure keeps existing");
});
