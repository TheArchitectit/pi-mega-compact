/**
 * rollout/assign.test.ts — deterministic stable-bucket assignment (VC5C).
 *
 * Asserts the assignment is a PURE function of the session id: identical input
 * yields identical output, different inputs diverge, and assignment NEVER
 * changes across "restart" (no Date.now / Math.random dependence).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assignSession, bucketInGate, gatePctForIndex } from "./assign.js";
import {
  ROLLOUT_BUCKETS,
  ROLLOUT_GATES,
} from "./types.js";

describe("assignSession: deterministic stable buckets", () => {
  test("assigns every session into 0..9999", () => {
    for (const id of ["a", "b", "session-1", "vc5c-canonical-session-digest-001", ""]) {
      const a = assignSession(id);
      assert.ok(a.bucket >= 0 && a.bucket < ROLLOUT_BUCKETS, `${id} in range`);
      assert.equal(a.schema, "rollout-assignment-v1");
    }
  });

  test("the SAME session id always maps to the SAME bucket", () => {
    const a = assignSession("session-alpha-0001");
    const b = assignSession("session-alpha-0001");
    assert.equal(a.bucket, b.bucket, "deterministic across calls");
  });

  test("different session ids diverge (no collision for this pair)", () => {
    const a = assignSession("session-alpha-0001");
    const b = assignSession("session-beta-0002");
    assert.notEqual(a.bucket, b.bucket);
  });

  test("assignment NEVER changes across process restart (no Date.now/Math.random)", () => {
    const first = assignSession("session-gamma-0003");
    // Simulate a restart by recomputing — must be identical.
    const restarted = assignSession("session-gamma-0003");
    assert.equal(first.bucket, restarted.bucket);
    assert.equal(first.gateIndex, restarted.gateIndex);
  });

  test("the canonical session digest maps to its golden bucket (8517)", () => {
    const a = assignSession("vc5c-canonical-session-digest-001");
    assert.equal(a.bucket, 8517, "ROL-BUCKET-001 golden bucket");
  });
});

describe("bucketInGate / gatePctForIndex", () => {
  test("gate 1% covers buckets 0..99", () => {
    assert.equal(bucketInGate(0, 1), true);
    assert.equal(bucketInGate(99, 1), true);
    assert.equal(bucketInGate(100, 1), false);
  });

  test("gate 100% covers all buckets", () => {
    assert.equal(bucketInGate(ROLLOUT_BUCKETS - 1, 100), true);
  });

  test("gatePctForIndex mirrors ROLLOUT_GATES", () => {
    for (let i = 0; i < ROLLOUT_GATES.length; i++) {
      assert.equal(gatePctForIndex(i as 0 | 1 | 2 | 3 | 4), ROLLOUT_GATES[i]);
    }
  });
});
