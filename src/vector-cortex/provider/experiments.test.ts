/**
 * provider/experiments.test.ts — VC7B randomized cache-experiment assignment.
 *
 * The core guarantee: arm assignment is a PURE function of (experimentId,
 * sessionId). That is what makes a lost assignment journal harmless — after a
 * restart the same hash re-derives the same arm, so no session ever switches
 * arms mid-experiment. These tests pin determinism, causal-admissibility
 * filtering, and session-arm consistency (CACHE-RANDOM-003).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVEN_SPLIT,
  EXPERIMENT_BUCKETS,
  armForBucket,
  assignExperiment,
  causalOnly,
  experimentBucket,
  isCausallyAdmissible,
  sessionArmsConsistent,
} from "./experiments.js";
import { economicsFixture } from "../cache/_economics-fixture.js";

test("bucket is stable across calls and within range", () => {
  const b1 = experimentBucket("exp-1", "session-xyz");
  const b2 = experimentBucket("exp-1", "session-xyz");
  assert.equal(b1, b2);
  assert.ok(b1 >= 0 && b1 < EXPERIMENT_BUCKETS, `bucket ${b1} in range`);
});

test("same session always gets the same arm (journal loss safe)", () => {
  const first = assignExperiment({ experimentId: "e", sessionId: "s", assignedAt: 1000 });
  const later = assignExperiment({ experimentId: "e", sessionId: "s", assignedAt: 9999 });
  assert.ok(first.ok && later.ok);
  if (!first.ok || !later.ok) return;
  assert.equal(first.assignment.arm, later.assignment.arm);
  assert.equal(first.assignment.bucket, later.assignment.bucket);
});

test("different sessions can differ but never exceed the split", () => {
  const counts = { A: 0, B: 0, C: 0 };
  for (let i = 0; i < EXPERIMENT_BUCKETS; i += 1) {
    const arm = armForBucket(i, EVEN_SPLIT);
    counts[arm] += 1;
  }
  // even split: A gets the extra bucket (3334), B/C get 3333
  assert.equal(counts.A, 3334);
  assert.equal(counts.B, 3333);
  assert.equal(counts.C, 3333);
});

test("forced arm downgrades source to non-causal", () => {
  const r = assignExperiment({ experimentId: "e", sessionId: "s", assignedAt: 1, forced: "C" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.assignment.arm, "C");
  assert.equal(r.assignment.source, "forced");
  assert.equal(isCausallyAdmissible(r.assignment), false);
});

test("shadow assignment is non-causal", () => {
  const r = assignExperiment({ experimentId: "e", sessionId: "s", assignedAt: 1, shadow: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.assignment.source, "shadow");
  assert.equal(isCausallyAdmissible(r.assignment), false);
});

test("randomized assignment is causal", () => {
  const r = assignExperiment({ experimentId: "e", sessionId: "s", assignedAt: 1 });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.assignment.source, "randomized");
  assert.equal(isCausallyAdmissible(r.assignment), true);
});

test("rejects empty ids and bad splits and bad arms", () => {
  const empty = assignExperiment({ experimentId: " ", sessionId: "s", assignedAt: 1 });
  assert.equal(empty.ok, false);

  const badSplit = assignExperiment({
    experimentId: "e",
    sessionId: "s",
    assignedAt: 1,
    split: { A: 0, B: 0, C: 0 },
  });
  assert.equal(badSplit.ok, false);

  const badArm = assignExperiment({ experimentId: "e", sessionId: "s", assignedAt: 1, forced: "Z" as never });
  assert.equal(badArm.ok, false);
});

test("causalOnly drops forced/shadow rows", () => {
  const a = assignExperiment({ experimentId: "e", sessionId: "s1", assignedAt: 1 });
  const b = assignExperiment({ experimentId: "e", sessionId: "s2", assignedAt: 1, forced: "B" });
  const c = assignExperiment({ experimentId: "e", sessionId: "s3", assignedAt: 1, shadow: true });
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;
  const kept = causalOnly([a.assignment, b.assignment, c.assignment]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.sessionId, "s1");
});

test("sessionArmsConsistent catches a session in two arms", () => {
  // Two forced assignments with the SAME sessionId but different arms. The
  // function keys by sessionId, so this is exactly the contamination it guards.
  const a = assignExperiment({ experimentId: "e", sessionId: "dup", assignedAt: 1, forced: "A" });
  const b = assignExperiment({ experimentId: "e", sessionId: "dup", assignedAt: 2, forced: "B" });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(sessionArmsConsistent([a.assignment, b.assignment]), false);
  assert.equal(sessionArmsConsistent([a.assignment]), true);
});

test("CACHE-RANDOM-003: repeated assignment after journal loss is consistent", () => {
  const fx = economicsFixture("CACHE-RANDOM-003");
  const repeat = fx.input.repeatAssignments ?? 5;
  const loseJournal = fx.input.loseJournalAfterFirst === true;
  assert.equal(loseJournal, true);
  const exp = fx.input.experiment ?? { experimentId: "exp", sessionId: "s", arm: "A", source: "randomized" };
  let prevArm: string | undefined;
  for (let i = 0; i < repeat; i += 1) {
    // assignedAt is injected and variable; arm must NOT depend on it (journal gone)
    const r = assignExperiment({
      experimentId: exp.experimentId,
      sessionId: exp.sessionId,
      assignedAt: i * 1000,
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    if (prevArm !== undefined) assert.equal(r.assignment.arm, prevArm, "arm stable across journal loss");
    prevArm = r.assignment.arm;
  }
});
