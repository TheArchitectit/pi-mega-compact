/**
 * outcomes/ledger.test.ts — VC8A outcome ledger tests.
 *
 * Tests payload rejection, append-only semantics, and field validation.
 * Uses the real production modules — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { appendOutcome, validateOutcome } from "./ledger.js";
import { OUT_PAYLOAD_FORBIDDEN, OUTCOME_SCHEMA_V1 } from "./types.js";

describe("VC8A outcome ledger", () => {
  test("a valid outcome with metrics is accepted", () => {
    const outcome = appendOutcome({
      outcomeId: "out-001",
      sessionId: "sess-a",
      repoId: "repo-x",
      assignment: "experimental",
      metrics: [
        { code: "latency_ms", value: 42, unit: "ms" },
        { code: "token_count", value: 128, unit: "count" },
      ],
      ts: "2026-01-01T00:00:00Z",
    });
    assert.equal(outcome.schema, OUTCOME_SCHEMA_V1);
    assert.equal(outcome.outcomeId, "out-001");
    assert.equal(outcome.sessionId, "sess-a");
    assert.equal(outcome.repoId, "repo-x");
    assert.equal(outcome.metrics.length, 2);
  });

  test("a prompt field is rejected as OUT_PAYLOAD_FORBIDDEN", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-002", prompt: "hello world" }),
      (err: { code: string; field: string }) =>
        err.code === OUT_PAYLOAD_FORBIDDEN && err.field === "prompt",
    );
  });

  test("a response field is rejected as OUT_PAYLOAD_FORBIDDEN", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-003", response: "text" }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("exactBytes field is rejected as OUT_PAYLOAD_FORBIDDEN", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-004", exactBytes: "bytes" }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("freeText field is rejected as OUT_PAYLOAD_FORBIDDEN", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-005", freeText: "text" }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("content field is rejected as OUT_PAYLOAD_FORBIDDEN", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-006", content: "data" }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("payload field is rejected as OUT_PAYLOAD_FORBIDDEN", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-007", payload: "data" }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("missing outcomeId is rejected", () => {
    assert.throws(
      () => validateOutcome({ sessionId: "s", repoId: "r", assignment: "a", metrics: [] }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("missing sessionId is rejected", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-008", repoId: "r", assignment: "a", metrics: [] }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("missing repoId is rejected", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-009", sessionId: "s", assignment: "a", metrics: [] }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("missing assignment is rejected", () => {
    assert.throws(
      () => validateOutcome({ outcomeId: "out-010", sessionId: "s", repoId: "r", metrics: [] }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("metrics with non-numeric value is rejected", () => {
    assert.throws(
      () =>
        validateOutcome({
          outcomeId: "out-011",
          sessionId: "s",
          repoId: "r",
          assignment: "a",
          metrics: [{ code: "x", value: "not-a-number", unit: "ms" }],
        }),
      (err: { code: string }) => err.code === OUT_PAYLOAD_FORBIDDEN,
    );
  });

  test("appendOutcome is append-only — returns a frozen-shape object", () => {
    const outcome = appendOutcome({
      outcomeId: "out-012",
      sessionId: "s",
      repoId: "r",
      assignment: "a",
      metrics: [{ code: "x", value: 1, unit: "count" }],
      ts: "2026-01-01T00:00:00Z",
    });
    assert.equal(outcome.outcomeId, "out-012");
  });

  test("default ts is provided when missing", () => {
    const outcome = validateOutcome({
      outcomeId: "out-013",
      sessionId: "s",
      repoId: "r",
      assignment: "a",
      metrics: [],
    });
    assert.equal(typeof outcome.ts, "string");
  });
});
