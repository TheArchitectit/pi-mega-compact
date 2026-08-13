/**
 * factory.test.ts — unit tests for the mega-compact bridge core.
 *
 * REAL stores only (no mocks/stubs): every method exercises the live engine
 * over a temp stateDir. Temp dir is created per-test and removed in finally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMegaBridge } from "./factory.js";
import { createTurnStore } from "../store/turns/index.js";
import type { BridgeMessage } from "./types.js";

/** Fresh temp stateDir + bridge, torn down in `finally`. */
function bridge() {
  const dir = mkdtempSync(join(tmpdir(), "mc-bridge-"));
  return { dir, b: createMegaBridge({ stateDir: dir }) };
}

const msg = (role: BridgeMessage["role"], text: string): BridgeMessage => ({ role, text });

test("compact → recallCheckpoints round-trip", () => {
  const { dir, b } = bridge();
  try {
    const sessionId = "sess_roundtrip";
    const messages = [
      msg("user", "we migrated the billing ledger to the new schema"),
      msg("assistant", "the billing ledger migration completed and reconciled every cent"),
    ];
    const compacted = b.compact({ sessionId, messages });
    assert.equal(compacted.skipped, false);
    assert.ok(compacted.summary.length > 0, "summary non-empty");
    assert.ok(compacted.checkpointId, "checkpointId set");
    assert.ok(compacted.tokenEstimate >= 0);

    const recall = b.recallCheckpoints({
      sessionId,
      query: "billing ledger migration",
    });
    assert.equal(recall.empty, false, "recall found the checkpoint");
    assert.ok(recall.block.length > 0, "recall block non-empty");
    assert.ok(recall.hitCount >= 1, "recall hitCount >= 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMemory → recallMemories round-trip", async () => {
  const { dir, b } = bridge();
  try {
    const probe = "unique recall probe text zzz-mega-compact-bridge";
    const id = b.addMemory({ content: probe, kind: "note", tags: ["probe"] });
    assert.ok(typeof id === "number", "addMemory returns a row id");

    const out = await b.recallMemories({ query: probe });
    assert.equal(out.empty, false, "memory recall found the probe");
    assert.ok(out.block.includes(probe), "recall block contains the probe text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordTurn ×3 → fork returns graceful NO_RECALL without injected checkpoints", () => {
  const { dir, b } = bridge();
  try {
    const conversationId = "conv_fork";
    const sessionId = "sess_fork";
    for (let i = 0; i < 3; i++) {
      b.recordTurn({
        conversationId,
        sessionId,
        turnIndex: i,
        role: "assistant",
        endedAt: Date.now() + i,
      });
    }
    // fork needs injected checkpoints at the fork turn; recordTurn alone does
    // not seed recall, so the bridge must return the graceful error variant.
    const result = b.fork({ parentConversationId: conversationId, turnIndex: 1 });
    assert.ok("error" in result, "fork returns the error variant");
    assert.equal(result.error, "NO_RECALL", "error is NO_RECALL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cortexQuery returns an array (empty ok on a fresh store)", () => {
  const { dir, b } = bridge();
  try {
    const out = b.cortexQuery({ query: "anything", limit: 5 });
    assert.ok(Array.isArray(out.results), "results is an array");
    assert.equal(out.hitCount, out.results.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close does not throw", () => {
  const { dir, b } = bridge();
  try {
    assert.doesNotThrow(() => b.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── S49R: monotonic child turn index + sessionTurnIndex carry ──

test("recordTurn: colliding turnIndex lands at next free index, sessionTurnIndex carried", () => {
  const { dir, b } = bridge();
  try {
    const conversationId = "conv_collide";
    const sessionId = "sess_collide";
    // First child segment writes turnIndex 0,1,2.
    for (let i = 0; i < 3; i++) {
      b.recordTurn({ conversationId, sessionId, turnIndex: i, role: "assistant", endedAt: Date.now() + i });
    }
    // Re-dispatched child: same conversation, session counter resets to 0.
    b.recordTurn({ conversationId, sessionId, turnIndex: 0, role: "assistant", endedAt: Date.now() + 100 });
    const store = createTurnStore({ stateDir: dir });
    const turns = store.query({ conversationId });
    assert.equal(turns.length, 4);
    const indices = turns.map((t) => t.turnIndex).sort((a, c) => a - c);
    assert.deepEqual(indices, [0, 1, 2, 3], "resumed child continues at high-water");
    // The last turn carried sessionTurnIndex 0 (the re-dispatched counter).
    const last = turns.find((t) => t.turnIndex === 3)!;
    assert.equal(last.sessionTurnIndex, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordTurn: same conversation, restarted turnIndex resumes monotonically (no throw)", () => {
  const { dir, b } = bridge();
  try {
    const conversationId = "conv_resume";
    const sessionId = "sess_resume";
    for (let i = 0; i <= 10; i++) {
      b.recordTurn({ conversationId, sessionId, turnIndex: i, role: "assistant", endedAt: Date.now() + i });
    }
    // Resume: event.turnIndex resets to 0 → must land at 11, not collide.
    b.recordTurn({ conversationId, sessionId, turnIndex: 0, role: "assistant", endedAt: Date.now() + 1000 });
    const store = createTurnStore({ stateDir: dir });
    const turns = store.query({ conversationId });
    assert.equal(turns.length, 12);
    const last = turns.find((t) => t.turnIndex === 11)!;
    assert.equal(last.sessionTurnIndex, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
