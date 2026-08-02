/**
 * debounce-skip-boundary.test.ts — DEBOUNCE-EXEMPTION, SKIP-FALLBACK,
 * DELTA-BOUNDARY, EPOCH-INVALIDATION tests + cleanup.
 * Split from mega-cache-replay.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { closeVectorIndex } from "../../src/store/vectorIndex.js";
import { harness, baseTmp } from "./_helpers.js";

test("DEBOUNCE-EXEMPTION: two events <2s apart (no clearDebounce) both replay; debounce never reached", async () => {
  const h = harness();
  const ctx = h.ctx();
  const session = h.buildSession("A", 14);

  h.clearDebounce();
  await h.fire("context", { type: "context", messages: session }, ctx);
  assert.equal(h.runtime.diagLiveTrimFires, 1, "first fire was fresh trim");

  const dbgBefore = h.runtime.diagCtxDebounce;
  const rpyBefore = h.runtime.diagLiveTrimReplays;

  await h.fire("context", { type: "context", messages: session }, ctx);
  await h.fire("context", { type: "context", messages: session }, ctx);

  assert.equal(
    h.runtime.diagCtxDebounce,
    dbgBefore,
    `debounce counter unchanged (${h.runtime.diagCtxDebounce} == ${dbgBefore}) — replay path was reached, not debounce`,
  );
  assert.ok(
    h.runtime.diagLiveTrimReplays >= rpyBefore + 2,
    `both events replayed (replays ${h.runtime.diagLiveTrimReplays} >= ${rpyBefore}+2)`,
  );
});

test("SKIP-FALLBACK: runCompact skipped + valid trimCache → replays cached trim", async () => {
  const h = harness();
  const ctx = h.ctx();
  const session = h.buildSession("A", 14);

  h.clearDebounce();
  await h.fire("context", { type: "context", messages: session }, ctx);
  assert.equal(
    h.runtime.diagLiveTrimFires,
    1,
    "fresh trim populated trimCache",
  );
  assert.ok(h.runtime.trimCache, "trimCache is set");

  h.runtime.trimCache.cut = 0;

  h.usage.percent = null;
  h.usage.tokens = 200100;
  h.clearDebounce();
  const oneMsg = [h.buildSession("X", 1)[0]];
  await h.fire("context", { type: "context", messages: oneMsg }, ctx);

  assert.ok(
    h.runtime.diagCtxRunSkipped >= 1,
    `diagCtxRunSkipped incremented (got ${h.runtime.diagCtxRunSkipped})`,
  );
  assert.ok(
    h.runtime.diagLiveTrimReplays >= 1,
    `skip→replay fired (replays ${h.runtime.diagLiveTrimReplays} >= 1)`,
  );
});

test("DELTA-BOUNDARY: 49% growth → replay; 51% growth → fresh compaction", async () => {
  const h = harness();
  const ctx = h.ctx();
  const session = h.buildSession("A", 14);

  h.usage.percent = 5;
  h.usage.tokens = 200000;

  h.clearDebounce();
  await h.fire("context", { type: "context", messages: session }, ctx);
  assert.ok(h.runtime.diagLiveTrimFires >= 1, "fresh trim at pct=5");
  assert.equal(h.runtime.trimCache?.ctxPct, 5, "ctxPct captured as 5");

  h.usage.percent = 54;
  h.clearDebounce();
  const { fires: f2, replays: r2 } = {
    fires: h.runtime.diagLiveTrimFires,
    replays: h.runtime.diagLiveTrimReplays,
  };
  await h.fire("context", { type: "context", messages: session }, ctx);
  assert.equal(
    h.runtime.diagLiveTrimFires,
    f2 + 1,
    `49% growth: fires +1 (replay counted as fire, ${f2}→${h.runtime.diagLiveTrimFires})`,
  );
  assert.equal(
    h.runtime.diagLiveTrimReplays,
    r2 + 1,
    `49% growth: replays +1 (${r2}→${h.runtime.diagLiveTrimReplays})`,
  );

  h.usage.percent = 56;
  h.clearDebounce();
  const { fires: f3, replays: r3 } = {
    fires: h.runtime.diagLiveTrimFires,
    replays: h.runtime.diagLiveTrimReplays,
  };
  await h.fire("context", { type: "context", messages: session }, ctx);
  assert.equal(
    h.runtime.diagLiveTrimFires,
    f3 + 1,
    `51% growth: fires +1 (fresh compaction, ${f3}→${h.runtime.diagLiveTrimFires})`,
  );
  assert.equal(
    h.runtime.diagLiveTrimReplays,
    r3,
    `51% growth: replays unchanged (fresh compaction ≠ replay, stays ${r3})`,
  );
});

test("EPOCH-INVALIDATION: checkpointId mismatch → replay does NOT fire (PREVENT-PI-001/002)", async () => {
  const h = harness();
  const ctx = h.ctx();
  const session = h.buildSession("A", 14);

  h.clearDebounce();
  await h.fire("context", { type: "context", messages: session }, ctx);
  assert.equal(h.runtime.diagLiveTrimFires, 1, "fresh trim");
  assert.ok(h.runtime.trimCache?.checkpointId, "trimCache has checkpointId");

  h.runtime.rt.lastCheckpointId = "cp-mismatch";
  assert.notEqual(
    h.runtime.trimCache?.checkpointId,
    h.runtime.rt.lastCheckpointId,
    "checkpointIds differ after simulated durable truncation",
  );

  const rpyBefore = h.runtime.diagLiveTrimReplays;
  h.clearDebounce();
  await h.fire("context", { type: "context", messages: session }, ctx);

  assert.equal(
    h.runtime.diagLiveTrimReplays,
    rpyBefore,
    `replay NOT incremented (was ${rpyBefore}, still ${h.runtime.diagLiveTrimReplays}) — stale trimCache rejected`,
  );
  assert.ok(
    h.runtime.diagLiveTrimFires >= 2 || h.runtime.diagCtxRunSkipped >= 1,
    `handler did NOT replay stale trimCache (fires=${h.runtime.diagLiveTrimFires}, skipped=${h.runtime.diagCtxRunSkipped}, replays=${h.runtime.diagLiveTrimReplays})`,
  );

  h.runtime.rt.lastCheckpointId = "cp-1";
});

test("cleanup", async () => {
  await closeVectorIndex();
  rmSync(baseTmp, { recursive: true, force: true });
});
