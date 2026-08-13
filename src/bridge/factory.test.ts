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
