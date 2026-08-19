/**
 * replay-dedup.test.ts — REPLAY + DEDUP tests.
 * Split from mega-cache-replay.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

test("REPLAY: >=2 gated context events within one epoch replay verbatim (byte-identical)", async () => {
  const h = harness();
  const ctx = h.ctx();
  const session = h.buildSession("A", 14);

  h.clearDebounce();
  const r1 = await h.fire(
    "context",
    { type: "context", messages: session },
    ctx,
  );
  h.clearDebounce();
  const r2 = await h.fire(
    "context",
    { type: "context", messages: session },
    ctx,
  );
  h.clearDebounce();
  const r3 = await h.fire(
    "context",
    { type: "context", messages: session },
    ctx,
  );

  const rt = h.runtime;
  assert.ok(rt.diagLiveTrimFires >= 1, "fresh trim fired on first event");
  assert.ok(
    rt.diagLiveTrimReplays >= 2,
    `replay fired >=2 (got ${rt.diagLiveTrimReplays})`,
  );
  assert.deepEqual(
    r2?.messages,
    r3?.messages,
    "replay messages byte-identical across replays",
  );
  assert.deepEqual(
    r1?.messages,
    r2?.messages,
    "replay matches fresh-trim view (stable prefix)",
  );
});

test("DEDUP: re-compact that dedups onto a DIFFERENT checkpoint still replays next (P2 fix)", async () => {
  const h = harness();
  h.usage.percent = null;
  h.usage.tokens = 200000;
  const ctx = h.ctx();
  const setA = h.buildSession("A", 14);
  const setB = h.buildSession("B", 14);
  const rt = h.runtime;

  h.clearDebounce();
  await h.fire("context", { type: "context", messages: setA }, ctx);
  const cpA = rt.rt.lastCheckpointId;
  assert.ok(cpA, "cp_A created on fresh trim");
  assert.equal(rt.diagLiveTrimFires, 1, "first fire was a fresh trim");

  h.usage.tokens = 200100;
  h.clearDebounce();
  await h.fire("context", { type: "context", messages: setB }, ctx);
  const cpB = rt.rt.lastCheckpointId;
  assert.notEqual(cpB, cpA, "cp_B is a different, genuinely new checkpoint");
  assert.equal(
    rt.rt.dedupSkips,
    0,
    "setB did not dedup (different vocabulary, fuzzy tiers off)",
  );

  h.usage.tokens = 200200;
  h.clearDebounce();
  const persistedBefore = rt.rt.persistedThisSession;
  await h.fire("context", { type: "context", messages: setA }, ctx);
  assert.ok(
    rt.rt.dedupSkips >= 1,
    "setA re-compact deduped onto an existing checkpoint",
  );
  // C1 (v0.21.10): the dedup path now stamps lastCheckpointId with the MATCHED
  // checkpoint (cp_A) — it backs this epoch. Pre-C1 it stayed at cp_B.
  assert.equal(
    rt.rt.lastCheckpointId,
    cpA,
    "dedup stamps lastCheckpointId with the matched checkpoint (cp_A)",
  );
  assert.equal(
    rt.rt.persistedThisSession,
    persistedBefore,
    "the dedup path did NOT change persistedThisSession (still means 'wrote NEW state')",
  );
  assert.equal(
    rt.trimCache?.checkpointId,
    rt.rt.lastCheckpointId,
    "trimCache.checkpointId keyed on lastCheckpointId (P2 fix), not dedup-volatile result.checkpointId",
  );

  const replaysBefore = rt.diagLiveTrimReplays;
  h.usage.tokens = 200200;
  h.clearDebounce();
  await h.fire("context", { type: "context", messages: setA }, ctx);
  assert.ok(
    rt.diagLiveTrimReplays > replaysBefore,
    `replay fired after dedup-onto-different-checkpoint (got ${rt.diagLiveTrimReplays}, was ${replaysBefore})`,
  );
});
