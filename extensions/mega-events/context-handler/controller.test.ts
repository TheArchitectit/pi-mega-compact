/**
 * extensions/mega-events/context-handler/controller.test.ts — VC6C-IMPL
 * production post-compact controller seam.
 *
 * Drives the REAL extensions-side production seam (`detectPostCompactGaps`,
 * `buildPostCompactViews`, `drivePostCompactRepair`, `driveOneRepair`,
 * `planFor`, `toRepairState`) against the REAL heal + reconstruct modules it
 * routes through. This is the authoritative test of the audit's headline claim:
 * the afterCompact placeholder is replaced by genuine gap detection that plans
 * and rebuilds, and emits nothing when there is no real gap (VC6C-IMPL-006).
 *
 * THE AUTHORITY IS NEVER WRITTEN: every assertion proves a derived plan /
 * pointer was produced or declined — no assertion mutates a durable authority
 * high-water, because the seam has no such write path.
 *
 * No mocks, no stubs. `emit` is an injected callback (the runtime supplies the
 * real `appendEvent`); the fixture supplies a deterministic one so the events a
 * drive emits can be asserted exactly. Runs via `npm test` (collectTestFiles
 * globs dist/extensions/**). No console (PREVENT-PI-004).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { rootDigest } from "../../../src/vector-cortex/heal/rebuild.js";
import { REPAIR_RATE_LIMIT_MS } from "../../../src/vector-cortex/heal/repair-types.js";
import {
  buildPostCompactViews,
  detectPostCompactGaps,
  driveOneRepair,
  drivePostCompactRepair,
  planFor,
  toRepairState,
  type PostCompactView,
} from "./controller.js";

/** A deterministic, capturing emit — the runtime's appendEvent stand-in. */
function capturingEmit(events: Array<{ name: string; payload: Record<string, unknown> }>) {
  return (name: string, payload: unknown): void => {
    events.push({ name, payload: payload as Record<string, unknown> });
  };
}

/** A rebuild source whose digest is guaranteed to verify (SHA-256 of bytes). */
function verifiedSource(payload: string) {
  const bytes = new Uint8Array(Buffer.from(payload, "utf8"));
  return { sourceBytes: bytes, expectedDigest: rootDigest(bytes) };
}

/** A rebuild source whose digest will NOT verify. */
function corruptSource(payload: string) {
  const bytes = new Uint8Array(Buffer.from(payload, "utf8"));
  return { sourceBytes: bytes, expectedDigest: "0".repeat(64) };
}

describe("VC6C-IMPL production post-compact controller seam", () => {
  test("plural: a derived tier behind authority is gapped; a level one is not", () => {
    const views: readonly PostCompactView[] = [
      { subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9, generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null },
      { subsystem: "topology", preCount: 9, postCount: 9, authorityHighWater: 9, generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null },
    ];
    const gapped = detectPostCompactGaps(views, views);
    assert.equal(gapped.length, 1, "only post_compact fell behind");
    assert.equal(gapped[0]!.subsystem, "post_compact");
  });

  test("the heal judge view: derived = post count, authority read never written", () => {
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 2, failedAttempts: 3, mode: "B", lastRebuildAtMs: 1000n,
    };
    const state = toRepairState(view);
    assert.equal(state.subsystem, "post_compact");
    assert.equal(state.derivedHighWater, 5n);
    assert.equal(state.authorityHighWater, 9n);
    assert.equal(state.generation, 2);
    assert.equal(state.failedAttempts, 3);
    assert.equal(state.mode, "B");
    assert.equal(state.lastRebuildAt, 1000n);
  });

  test("planFor maps a gapped view into the production plan (gen+1, unbuilt window)", () => {
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null,
    };
    const plan = planFor(view);
    assert.equal(plan.schema, "repair-plan-v1");
    assert.deepEqual(plan.range, [6, 9]);
    assert.equal(plan.generation, 2, "a plan targets the current generation + 1");
    assert.ok(plan.backoffMs >= 0);
    // backoff is deterministic (the plan seam reuses heal computeBackoff).
    assert.equal(planFor(view).backoffMs, plan.backoffMs);
  });

  test("driveOneRepair: an empty rebuild is declined with a backoff event, old gen retained", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null,
    };
    // No bytes -> HEAL_REBUILD_FAILED -> pointer stays put.
    const out = driveOneRepair(view, capturingEmit(events), {
      sourceBytes: new Uint8Array(0),
      expectedDigest: "",
    });
    assert.equal(out.rebuilt.pointer.switched, false);
    assert.equal(out.rebuilt.pointer.generation, 1, "old generation retained");
    assert.equal(events[0]!.name, "vector_cortex_repair_planned");
    const backoff = events[1]!;
    assert.equal(backoff.name, "vector_cortex_repair_backoff");
    assert.equal(backoff.payload.code, "HEAL_REBUILD_FAILED");
  });

  test("driveOneRepair: a verified rebuild flips the pointer and emits pointer-switched", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null,
    };
    const out = driveOneRepair(view, capturingEmit(events), verifiedSource("post-compact-state"));
    assert.equal(out.rebuilt.pointer.switched, true);
    assert.equal(out.rebuilt.pointer.generation, 2, "strict successor went live");
    assert.equal(events[0]!.name, "vector_cortex_repair_planned");
    const switched = events[1]!;
    assert.equal(switched.name, "vector_cortex_repair_pointer_switched");
    assert.equal(switched.payload.fromGeneration, 1);
    assert.equal(switched.payload.toGeneration, 2);
  });

  test("driveOneRepair: a failed digest verification keeps the old pointer and emits a backoff code", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null,
    };
    const out = driveOneRepair(view, capturingEmit(events), corruptSource("post-compact-state"));
    assert.equal(out.rebuilt.pointer.switched, false, "digest mismatch must not switch");
    assert.equal(out.rebuilt.pointer.generation, 1, "old pointer retained");
    const res = out.rebuilt.result;
    if (res.ok) {
      assert.fail(`${JSON.stringify(res.digest)} should not verify a corrupt digest`);
    } else {
      assert.equal(res.code, "HEAL_REPAIR_DIGEST_MISMATCH");
    }
    const backoff = events[1]!;
    assert.equal(backoff.name, "vector_cortex_repair_backoff");
    assert.equal(backoff.payload.code, "HEAL_REPAIR_DIGEST_MISMATCH");
  });

  test("drivePostCompactRepair: a subsystem inside the 5-min rate-limit window is skipped (no emit)", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const nowMs = 1_000_000n;
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A",
      // last rebuild just inside the window: now - 1ms < RATE_LIMIT.
      lastRebuildAtMs: nowMs - 1n,
    };
    drivePostCompactRepair([view], nowMs, capturingEmit(events), () => verifiedSource("x"));
    assert.deepEqual(events, [], "rate-limited subsystem emits nothing (boundary exclusive)");
  });

  test("drivePostCompactRepair: a subsystem at the rate-limit boundary exactly (now - RATE_LIMIT) is plannable", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const RATE = BigInt(REPAIR_RATE_LIMIT_MS);
    const nowMs = 1_000_000n;
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 5, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A",
      lastRebuildAtMs: nowMs - RATE, // exactly at the boundary => NOT rate limited.
    };
    drivePostCompactRepair([view], nowMs, capturingEmit(events), () => verifiedSource("x"));
    assert.equal(events.length, 2, "boundary-exclusive: eligible exactly at REPAIR_RATE_LIMIT_MS");
    assert.equal(events[0]!.name, "vector_cortex_repair_planned");
  });

  test("drivePostCompactRepair: level-with-authority emits nothing (VC6C-IMPL-006 no opposite rebuild)", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const nowMs = 1_000_000n;
    const view: PostCompactView = {
      subsystem: "post_compact", preCount: 9, postCount: 9, authorityHighWater: 9,
      generation: 1, failedAttempts: 0, mode: "A", lastRebuildAtMs: null,
    };
    drivePostCompactRepair([view], nowMs, capturingEmit(events), () => verifiedSource("x"));
    assert.deepEqual(events, [], "no rebuild without a real gap");
  });

  test("buildPostCompactViews: a normal compact yields no real gap and drives a no-op", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const views = buildPostCompactViews(9, 1);
    assert.equal(views.length, 1);
    assert.equal(views[0]!.subsystem, "post_compact");
    // post-count == authority => level => not plannable.
    drivePostCompactRepair(views, 1_000_000n, capturingEmit(events), () => verifiedSource("x"));
    assert.deepEqual(events, [], "a normal compact post-count at authority emits nothing");
  });
});
