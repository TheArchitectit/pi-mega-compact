/**
 * turnStore.test.ts — S49A isolated turns.db store tests.
 *
 * Proves: (1) S48 CRUD + fork behavior works against the isolated store,
 * (2) turns.db is a SEPARATE file from the memory sqlite.db (isolation),
 * (3) the module graph is pi-agnostic (no @earendil-works / extensions imports).
 * No network. Real stores with temp state dirs.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnStore, turnDbPath, TURNS_DB_FILE } from "./index.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mc-turnstore-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, `run-${counter++}`);
}

test("recordTurn upsert + getTurn", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const conv = store.ensureConversationId("sess_a");
  const id = store.recordTurn({
    conversationId: conv,
    sessionId: "sess_a",
    turnIndex: 0,
    endedAt: 1000,
    ctxTokens: 500,
    modelId: "test-model",
  });
  assert.ok(id > 0);
  const got = store.getTurn(conv, 0);
  assert.equal(got?.turnIndex, 0);
  assert.equal(got?.ctxTokens, 500);
  assert.equal(got?.modelId, "test-model");
  // Upsert same (session, turn): overwrites metrics, same row.
  const id2 = store.recordTurn({ conversationId: conv, sessionId: "sess_a", turnIndex: 0, ctxTokens: 999 });
  assert.equal(id2, id);
  assert.equal(store.getTurn(conv, 0)?.ctxTokens, 999);
  store.close();
});

test("recordTurnRecall + listTurnRecall ordered by score", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const conv = store.ensureConversationId("sess_b");
  const id = store.recordTurn({ conversationId: conv, sessionId: "sess_b", turnIndex: 0 });
  store.recordTurnRecall(id, [
    { checkpointId: "cp1", score: 0.5, source: "flat" },
    { checkpointId: "cp2", score: 0.9, source: "raptor", raptorLevel: 1 },
  ]);
  const rec = store.listTurnRecall(id);
  assert.equal(rec.length, 2);
  assert.equal(rec[0].checkpointId, "cp2"); // highest score first
  assert.equal(rec[0].raptorLevel, 1);
  assert.equal(rec[0].source, "raptor");
  store.close();
});

test("listConversationTurns ascending by turn_index", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const conv = store.ensureConversationId("sess_c");
  store.recordTurn({ conversationId: conv, sessionId: "sess_c", turnIndex: 2 });
  store.recordTurn({ conversationId: conv, sessionId: "sess_c", turnIndex: 0 });
  store.recordTurn({ conversationId: conv, sessionId: "sess_c", turnIndex: 1 });
  const turns = store.listConversationTurns(conv);
  assert.deepEqual(turns.map((t) => t.turnIndex), [0, 1, 2]);
  store.close();
});

test("ensureConversationId stable across calls (resumes)", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const a = store.ensureConversationId("sess_d");
  const b = store.ensureConversationId("sess_d");
  assert.equal(a, b);
  assert.ok(a.startsWith("conv_"));
  // Distinct sessions get distinct conversations.
  assert.notEqual(store.ensureConversationId("sess_e"), a);
  store.close();
});

test("forkConversation lineage + replay set", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const parent = store.ensureConversationId("sess_parent");
  const turnId = store.recordTurn({ conversationId: parent, sessionId: "sess_parent", turnIndex: 3 });
  store.recordTurnRecall(turnId, [{ checkpointId: "cp_fork", score: 0.77, source: "flat" }]);
  const { conversationId: child, recalled } = store.forkConversation(parent, turnId);
  assert.ok(child.startsWith("conv_"));
  assert.notEqual(child, parent);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].checkpointId, "cp_fork");
  store.close();
});

test("clearTurns cascades recall rows", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const conv = store.ensureConversationId("sess_clear");
  const id = store.recordTurn({ conversationId: conv, sessionId: "sess_clear", turnIndex: 0 });
  store.recordTurnRecall(id, [{ checkpointId: "cp", score: 0.5, source: "flat" }]);
  store.clearTurns("sess_clear");
  assert.equal(store.listConversationTurns(conv).length, 0);
  assert.equal(store.listTurnRecall(id).length, 0);
  store.close();
});

test("pruneTurns keeps min-per-conversation + preserves fork points", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const now = 1_000_000;
  const old = now - 90 * 24 * 3600 * 1000; // 90 days ago
  // Conversation with 5 old turns.
  const conv = store.ensureConversationId("sess_prune");
  for (let i = 0; i < 5; i++) {
    store.recordTurn({ conversationId: conv, sessionId: "sess_prune", turnIndex: i, endedAt: old });
  }
  // Fork point at turn 0 (NOT the most recent) — must be preserved by the
  // conversation_branches reference even though it is neither recent nor kept
  // by the min-window.
  const forkTurn = store.getTurn(conv, 0)!;
  store.forkConversation(conv, forkTurn.id);
  const { deletedTurns } = store.pruneTurns({ olderThanMs: 30 * 24 * 3600 * 1000, keepMinPerConversation: 1, now });
  // 5 old turns; min-window keeps turn 4 (rn=1); fork point preserves turn 0
  // → turns 1,2,3 deleted (3 deletions).
  assert.equal(deletedTurns, 3);
  const remaining = store.listConversationTurns(conv).map((t) => t.turnIndex);
  assert.deepEqual(remaining.sort(), [0, 4]); // fork point (0) + most-recent (4) preserved
  store.close();
});

test("ISOLATION: turn writes go to turns.db, not the memory sqlite.db", () => {
  const dir = stateDir();
  const store = createTurnStore(dir);
  const conv = store.ensureConversationId("sess_iso");
  store.recordTurn({ conversationId: conv, sessionId: "sess_iso", turnIndex: 0 });
  store.close();
  // turns.db exists at the resolved path.
  assert.ok(existsSync(turnDbPath(dir)), "turns.db should exist");
  assert.equal(turnDbPath(dir), join(dir, TURNS_DB_FILE));
  // The memory sqlite.db was NOT created by a turn write (openTurnStore only
  // opens turns.db; it never touches the memory store's sqlite.db).
  const files = readdirSync(dir);
  assert.ok(!files.includes("sqlite.db"), "turn writes must not create/open the memory sqlite.db");
});

test("REUSE-CLEAN: no pi imports anywhere in src/store/turns/", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const banned = /@earendil-works|extensions\//;
  for (const f of readdirSync(here)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(here, f), "utf8");
    assert.ok(!banned.test(src), `${f} must not import pi runtime / extensions (reuse contract)`);
  }
});
