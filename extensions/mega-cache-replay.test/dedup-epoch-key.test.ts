/**
 * dedup-epoch-key.test.ts — C1 (v0.21.10): lastCheckpointId is stamped on the
 * DEDUP path too, so the D.2 replay key survives a dedup-only runtime session.
 *
 * Incident shape: after a process restart `rt` is rebuilt (lastCheckpointId =
 * undefined) while checkpoints persist in the store. If every compaction in the
 * new runtime session dedups onto an existing checkpoint, pre-C1 the id was
 * NEVER set → liveTrim's trimCache fell back to result.checkpointId (the matched
 * id) → `trimCache.checkpointId === rt.lastCheckpointId` compared a real id to
 * undefined → replay never matched and the full pipeline re-ran on every context
 * event (liveTrimReplays: 0).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

test("C1 dedup-only epoch: lastCheckpointId is set and the replay key matches", async () => {
  const h = harness();
  h.usage.percent = null;
  h.usage.tokens = 200000;
  const ctx = h.ctx();
  const setA = h.buildSession("A", 14);
  const rt = h.runtime;

  // Fire 1: fresh trim creates the checkpoint backing this epoch.
  h.clearDebounce();
  await h.fire("context", { type: "context", messages: setA }, ctx);
  const cpA = rt.rt.lastCheckpointId;
  assert.ok(cpA, "cp_A created on the fresh trim");

  // Simulate the process restart: rt loses lastCheckpointId + the trim cache,
  // while the checkpoint itself persists in the store (so the next compaction
  // of the same region DEDUPS onto it).
  rt.rt.lastCheckpointId = undefined;
  rt.rt.persistedThisSession = false;
  rt.trimCache = undefined;

  // Fire 2: same region → dedups onto cp_A. Pre-C1 lastCheckpointId stayed
  // undefined here, which is the whole bug.
  h.usage.tokens = 200100;
  h.clearDebounce();
  await h.fire("context", { type: "context", messages: setA }, ctx);
  assert.ok(rt.rt.dedupSkips >= 1, "fire 2 deduped onto the existing checkpoint");
  assert.equal(
    rt.rt.lastCheckpointId,
    cpA,
    "C1: the deduped path stamps lastCheckpointId with the matched checkpoint",
  );
  assert.equal(
    rt.rt.persistedThisSession,
    false,
    "C1: the deduped path does NOT set persistedThisSession (no new state written)",
  );
  assert.ok(rt.trimCache, "the dedup fire still built + cached a trim view");
  assert.equal(
    rt.trimCache.checkpointId,
    rt.rt.lastCheckpointId,
    "C1: trimCache key === rt.lastCheckpointId → the D.2 replay check can match",
  );

  // Fire 3: the D.2 replay branch must now engage. Pre-C1 this was impossible in
  // a dedup-only session (undefined !== "chkpt_00N") and the pipeline re-ran.
  const replaysBefore = rt.diagLiveTrimReplays;
  h.usage.tokens = 200100; // no growth → cache is not stale
  h.clearDebounce();
  await h.fire("context", { type: "context", messages: setA }, ctx);
  assert.ok(
    rt.diagLiveTrimReplays > replaysBefore,
    `D.2 replay engaged after a dedup-only epoch (replays ${rt.diagLiveTrimReplays} > ${replaysBefore})`,
  );
});

test("C1 non-dedup path still sets BOTH lastCheckpointId and persistedThisSession", async () => {
  const h = harness();
  h.usage.percent = null;
  h.usage.tokens = 200000;
  const ctx = h.ctx();
  const rt = h.runtime;
  assert.equal(rt.rt.lastCheckpointId, undefined, "fresh runtime has no checkpoint");

  h.clearDebounce();
  await h.fire("context", { type: "context", messages: h.buildSession("A", 14) }, ctx);
  assert.equal(rt.rt.dedupSkips, 0, "the first compaction did not dedup");
  assert.ok(rt.rt.lastCheckpointId, "non-dedup path sets lastCheckpointId (unchanged)");
  assert.equal(
    rt.rt.persistedThisSession,
    true,
    "non-dedup path sets persistedThisSession (unchanged)",
  );
});
