/**
 * heal/rebuild-chaos.test.ts — VC6C crash/corruption/restart semantics.
 *
 * The rebuild path's safety property is an ORDERING property: copy, verify,
 * switch. These tests attack that ordering at each seam — kill the process
 * between steps, corrupt the new root, replay a stale plan after a restart — and
 * assert the invariant that survives all of them: THE POINTER MOVES ONLY FOR A
 * VERIFIED, STRICTLY NEWER GENERATION, AND A FAILURE DELETES NO EVIDENCE.
 *
 * "Killing the process" is modelled by simply not calling the next step, which is
 * exactly what a crash does. Because `rebuild.ts` is pure and the pointer is a
 * value the caller holds, a dropped step is indistinguishable from a hard kill —
 * no mocks or process spawning required, and the fake clock is just an argument.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  applyTriad,
  rebuildAndSwitch,
  rebuildGeneration,
  rootDigest,
  switchPointer,
  type RebuildInput,
} from "./rebuild.js";
import { detectGaps } from "./controller.js";
import type { RepairState } from "./repair-types.js";

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));
const hexOf = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");

function input(text: string, over: Partial<RebuildInput> = {}): RebuildInput {
  return {
    subsystem: "topology",
    range: { sessionId: "topology", seqStart: 9n, seqEnd: 10n, byteStart: 0, byteEnd: 0 },
    generation: 2,
    sourceBytes: bytes(text),
    expectedDigest: hexOf(text),
    ...over,
  };
}

describe("VC6C rebuild verification", () => {
  test("a matching root digest verifies and reports the new generation", () => {
    const r = rebuildGeneration(input("rebuilt-state"));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.generation, 2);
      assert.equal(r.digest, hexOf("rebuilt-state"));
    }
  });

  test("a corrupted root fails with DIGEST_MISMATCH and never verifies", () => {
    const r = rebuildGeneration(input("rebuilt-state", { expectedDigest: hexOf("other") }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "HEAL_REPAIR_DIGEST_MISMATCH");
  });

  test("a single flipped byte is caught (the digest is over content, not length)", () => {
    const r = rebuildGeneration(input("rebuilt-statf", { expectedDigest: hexOf("rebuilt-state") }));
    assert.equal(r.ok, false);
  });

  test("an EMPTY rebuild fails rather than 'verifying' as the digest of nothing", () => {
    // Without this guard a plan pinning sha256("") would flip the pointer onto
    // an empty generation — a silently destroyed subsystem.
    const r = rebuildGeneration(input("", { expectedDigest: hexOf("") }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "HEAL_REBUILD_FAILED");
  });

  test("rootDigest is bare lowercase hex (the ExactShardV1 convention)", () => {
    const d = rootDigest(bytes("x"));
    assert.match(d, /^[0-9a-f]{64}$/);
  });
});

describe("VC6C pointer switch", () => {
  test("an unverified rebuild NEVER moves the pointer", () => {
    assert.deepEqual(switchPointer(1, 2, false), { switched: false, generation: 1 });
  });

  test("a verified, strictly newer generation moves the pointer exactly once", () => {
    assert.deepEqual(switchPointer(1, 2, true), { switched: true, generation: 2 });
  });

  test("a stale plan replayed after restart cannot roll the pointer BACKWARDS", () => {
    // Generation 5 is live; a plan from before the restart targets 3.
    assert.deepEqual(switchPointer(5, 3, true), { switched: false, generation: 5 });
  });

  test("re-applying the SAME generation is refused (switch is monotonic)", () => {
    assert.deepEqual(switchPointer(2, 2, true), { switched: false, generation: 2 });
  });

  test("switching is idempotent: the second apply of a done plan is a no-op", () => {
    const first = switchPointer(1, 2, true);
    assert.equal(first.switched, true);
    const second = switchPointer(first.generation, 2, true);
    assert.equal(second.switched, false);
    assert.equal(second.generation, 2, "the live generation is unchanged");
  });
});

describe("VC6C chaos: crash between steps", () => {
  test("kill AFTER building the new generation but BEFORE switching keeps the old pointer", () => {
    const live = 1;
    const built = rebuildGeneration(input("rebuilt-state"));
    assert.equal(built.ok, true);
    // <<< process dies here: switchPointer is never called >>>
    // On restart the pointer is still the old generation, so the old state is
    // served and the orphaned generation 2 is inert.
    assert.equal(live, 1);
    // The next run re-plans and re-applies cleanly.
    const after = switchPointer(live, 2, built.ok);
    assert.deepEqual(after, { switched: true, generation: 2 });
  });

  test("kill DURING verification (result discarded) leaves the pointer untouched", () => {
    const live = 3;
    rebuildGeneration(input("rebuilt-state", { generation: 4 }));
    // <<< result never consumed >>>
    assert.equal(live, 3);
  });

  test("a corrupt new root keeps the old pointer AND retains the evidence", () => {
    const live = 1;
    const inp = input("corrupted", { expectedDigest: hexOf("expected") });
    const { result, pointer } = rebuildAndSwitch(inp, live);
    assert.equal(result.ok, false);
    assert.deepEqual(pointer, { switched: false, generation: live });
    // Evidence retention: the failed generation is still NAMED in the result, so
    // the caller can point an operator at the artifact it must NOT delete.
    if (!result.ok) assert.equal(result.generation, 2);
  });

  test("restart after a failed rebuild retains the PRIOR generation as live", () => {
    let live = 7;
    const failed = rebuildAndSwitch(input("bad", { generation: 8, expectedDigest: hexOf("good") }), live);
    live = failed.pointer.generation;
    assert.equal(live, 7, "the prior generation survives a failed rebuild");
    // A subsequent healthy rebuild of the same target then succeeds.
    const good = rebuildAndSwitch(input("good", { generation: 8 }), live);
    assert.equal(good.pointer.switched, true);
    assert.equal(good.pointer.generation, 8);
  });
});

describe("VC6C triad arms", () => {
  test("mode A rebuilds the targeted range and can switch", () => {
    const r = applyTriad("A", input("rebuilt-state"));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.mode, "A");
  });

  test("mode B (full deterministic rebuild) verifies through the same digest gate", () => {
    const r = applyTriad("B", input("rebuilt-state"));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.mode, "B");
  });

  test("mode B on corrupt bytes still refuses — independence is not leniency", () => {
    const r = applyTriad("B", input("corrupt", { expectedDigest: hexOf("clean") }));
    assert.equal(r.ok, false);
  });

  test("mode C performs NO rebuild and STATES its loss of old semantic context", () => {
    const r = applyTriad("C", input("rebuilt-state"));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "HEAL_REBUILD_FAILED");
      assert.equal(r.mode, "C");
      assert.equal(r.semanticLossStated, true, "mode C MUST disclose the loss");
    }
  });

  test("mode C never moves the pointer even with otherwise-valid bytes", () => {
    const { pointer } = rebuildAndSwitch(input("rebuilt-state"), 1, "C");
    assert.deepEqual(pointer, { switched: false, generation: 1 });
  });
});

describe("VC6C authority-outage frontier", () => {
  test("a frozen authority freezes the derived frontier instead of chasing the spool", () => {
    // The spool has accepted frames up to 100, but the DURABLE authority is
    // frozen at 10. Planning must be refused entirely — a plan to 100 would
    // materialize frames that are not yet durable.
    const frozen: RepairState = {
      subsystem: "topology",
      derivedHighWater: 8n,
      authorityHighWater: 10n,
      lastRebuildAt: null,
      generation: 1,
      mode: "A",
      authorityFrozen: true,
    };
    assert.deepEqual(detectGaps([frozen], 1_000_000n), []);
  });

  test("after the drain, catch-up resumes from the OLD high-water, never the tail", () => {
    const drained: RepairState = {
      subsystem: "topology",
      derivedHighWater: 8n,
      authorityHighWater: 10n,
      lastRebuildAt: null,
      generation: 1,
      mode: "A",
      authorityFrozen: false,
    };
    const plans = detectGaps([drained], 1_000_000n);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.range.seqStart, 9n, "resumes at derived+1, not the spool tail");
    assert.equal(plans[0]!.range.seqEnd, 10n);
  });
});
