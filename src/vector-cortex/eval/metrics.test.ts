/**
 * vector-cortex/eval/metrics.test.ts — VC0A metric ordering + histogram tests.
 *
 * Covers EVAL-ORDER-003 (equal seq rows use event-name order), EVAL-BUCKET-001
 * (1ms and 250ms land on inclusive boundaries), and permutation-stability of
 * canonical order + histogram totals (EVAL-010).
 *
 * Node --test, real evaluation logic (no mocks).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sortCanonical,
  bucketHistogram,
  bucketIndex,
  buildMetrics,
} from "./metrics.js";
import type { MetricEventV1 } from "./types.js";

function m(parts: Partial<MetricEventV1>): MetricEventV1 {
  return {
    session: "s1",
    seq: 1,
    event: "e",
    value: 0,
    unit: "count",
    mode: "A",
    ...parts,
  };
}

describe("sortCanonical (session,seq,event)", () => {
  test("EVAL-ORDER-003: equal seq rows use event-name order", () => {
    const rows = [
      m({ event: "z", value: 3 }),
      m({ event: "a", value: 1 }),
    ];
    const res = sortCanonical(rows);
    assert.deepEqual(
      res.map((r) => [r.session, r.seq, r.event]),
      [
        ["s1", 1, "a"],
        ["s1", 1, "z"],
      ],
    );
  });

  test("orders by session, then seq, then event", () => {
    const rows = [
      m({ session: "s2", seq: 1, event: "b" }),
      m({ session: "s1", seq: 2, event: "a" }),
      m({ session: "s1", seq: 1, event: "b" }),
      m({ session: "s1", seq: 1, event: "a" }),
    ];
    const res = sortCanonical(rows);
    assert.deepEqual(
      res.map((r) => [r.session, r.seq, r.event]),
      [
        ["s1", 1, "a"],
        ["s1", 1, "b"],
        ["s1", 2, "a"],
        ["s2", 1, "b"],
      ],
    );
  });

  test("equal content stays separate occurrences", () => {
    const a = m({ value: 1 });
    const b = m({ value: 1 });
    const res = sortCanonical([b, a]);
    assert.equal(res.length, 2);
  });
});

describe("bucketHistogram inclusive boundaries", () => {
  test("EVAL-BUCKET-001: 1ms and 250ms land on inclusive boundaries", () => {
    const rows = [
      m({ unit: "ms", value: 1 }),
      m({ unit: "ms", value: 250 }),
      m({ unit: "ms", value: 250 }),
    ];
    const h = bucketHistogram(rows);
    assert.equal(bucketIndex(1), 0);
    assert.equal(bucketIndex(250), 6);
    assert.deepEqual(h.cells, [1, 0, 0, 0, 0, 0, 2, 0]);
    assert.equal(h.overflow, 0);
    assert.equal(h.total, 3);
  });

  test("overflow past 250ms kept separate", () => {
    const rows = [
      m({ unit: "ms", value: 10 }),
      m({ unit: "ms", value: 251 }),
      m({ unit: "ms", value: 300 }),
    ];
    const h = bucketHistogram(rows);
    assert.deepEqual(h.cells, [0, 0, 1, 0, 0, 0, 0, 2]);
    assert.equal(h.overflow, 2);
    assert.equal(h.total, 3);
  });

  test("non-latency samples do not enter the histogram", () => {
    const rows = [m({ unit: "count", value: 999 })];
    const h = bucketHistogram(rows);
    assert.equal(h.total, 0);
  });
});

describe("permutation stability", () => {
  test("canonical order and histogram totals are permutation-stable", () => {
    const rows = [
      m({ session: "s1", seq: 1, unit: "ms", value: 5 }),
      m({ session: "s1", seq: 3, unit: "ms", value: 25 }),
      m({ session: "s1", seq: 2, unit: "ms", value: 5 }),
      m({ session: "s2", seq: 1, unit: "ms", value: 100 }),
    ];
    const shuffled = [...rows].reverse();
    const r1 = buildMetrics(rows);
    const r2 = buildMetrics(shuffled);
    assert.deepEqual(r1.histogram.cells, r2.histogram.cells);
    assert.equal(r1.histogram.total, r2.histogram.total);
    assert.deepEqual(r1.histogram.cells, [0, 2, 0, 1, 0, 1, 0, 0]);
    assert.deepEqual(
      r1.rows.map((r) => [r.session, r.seq, r.event]),
      [
        ["s1", 1, "e"],
        ["s1", 2, "e"],
        ["s1", 3, "e"],
        ["s2", 1, "e"],
      ],
    );
  });
});
