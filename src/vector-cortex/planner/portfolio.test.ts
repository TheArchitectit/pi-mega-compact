/**
 * planner/portfolio.test.ts — unit tests for planPortfolio / planGreedyClosed /
 * planManifestDigest (VC5A tasks 3 + 4). Exercises the mandatory-first closure,
 * 0/1 admission, framing math and manifest identity against the REAL module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planPortfolio,
  planGreedyClosed,
  framedCost,
  mandatoryFramedCost,
  compareByRatio,
  planManifestDigest,
  validatePlanManifest,
} from "./portfolio.js";
import { DEFAULT_FRAMING } from "./types.js";
import type { PlanCandidate } from "./types.js";

function cand(
  nodeId: string,
  tokenEstimate: number,
  utility: number,
  sourceSeq: bigint,
  mandatory: boolean,
): PlanCandidate {
  return { nodeId, tokenEstimate, utility, sourceSeq, mandatory };
}

const ZERO = { perNode: 0, overhead: 0 };
const base = {
  dagDigest: "x".repeat(64),
  dependencyHighWater: 100n,
};

test("framedCost adds the per-node envelope to the content estimate", () => {
  assert.equal(framedCost(cand("a", 10, 1, 1n, false), DEFAULT_FRAMING), 14);
});

test("mandatoryFramedCost adds per-node * count + overhead", () => {
  assert.equal(mandatoryFramedCost(30, 2, DEFAULT_FRAMING), 30 + 8 + 8);
});

test("compareByRatio orders by utility-per-token then source seq then id", () => {
  const hi = cand("hi", 10, 20, 2n, false);
  const lo = cand("lo", 10, 5, 1n, false);
  // hi ratio 2.0 > lo ratio 0.5
  assert.ok(compareByRatio(hi, lo, ZERO) < 0);
  // Equal ratios → source seq wins.
  const early = cand("early", 10, 10, 1n, false);
  const late = cand("late", 10, 10, 2n, false);
  assert.ok(compareByRatio(early, late, ZERO) < 0);
  // Equal ratio + equal seq → id bytes win.
  const aaa = cand("aaa", 10, 10, 1n, false);
  const bbb = cand("bbb", 10, 10, 1n, false);
  assert.ok(compareByRatio(aaa, bbb, ZERO) < 0);
});

test("a fitting mandatory closure is admitted in full with framing", () => {
  const res = planPortfolio({
    ...base,
    candidates: [cand("m1", 10, 100, 1n, true), cand("m2", 20, 200, 2n, true)],
    mandatoryTokenEstimate: 30,
    tokenBudget: 100,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual([...res.plan.selectedNodeIds], ["m1", "m2"]);
    assert.equal(res.plan.tokenTotal, 30);
  }
});

test("a mandatory closure over budget returns MANDATORY_CLOSURE_OVER_BUDGET without dropping evidence", () => {
  const res = planPortfolio({
    ...base,
    candidates: [cand("m1", 50, 100, 1n, true), cand("m2", 51, 200, 2n, true)],
    mandatoryTokenEstimate: 101,
    tokenBudget: 100,
    framing: ZERO,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "MANDATORY_CLOSURE_OVER_BUDGET");
    assert.deepEqual([...res.mandatory].sort(), ["m1", "m2"]);
    assert.equal(res.mandatoryCost, 101);
    assert.equal(res.tokenBudget, 100);
  }
});

test("framing cost is added on top of the VC4C content-only estimate", () => {
  const res = planPortfolio({
    ...base,
    candidates: [cand("m1", 10, 100, 1n, true), cand("m2", 20, 200, 2n, true)],
    mandatoryTokenEstimate: 30,
    tokenBudget: 100,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.plan.tokenTotal, 46, "30 + 4*2 + 8");
});

test("optional candidates compete for the remaining budget by utility-per-token", () => {
  const res = planPortfolio({
    ...base,
    candidates: [
      cand("hi", 10, 20, 1n, false),
      cand("mid", 10, 10, 2n, false),
      cand("lo", 10, 5, 3n, false),
    ],
    mandatoryTokenEstimate: 0,
    tokenBudget: 20,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual([...res.plan.selectedNodeIds].sort(), ["hi", "mid"]);
    assert.equal(res.plan.tokenTotal, 20);
  }
});

test("an optional candidate that does not fit is omitted, never truncated", () => {
  const res = planPortfolio({
    ...base,
    candidates: [
      cand("hi", 10, 20, 1n, false),
      cand("mid", 10, 10, 2n, false),
    ],
    mandatoryTokenEstimate: 0,
    tokenBudget: 10,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual([...res.plan.selectedNodeIds], ["hi"]);
    assert.ok(res.plan.omissions.some((o) => o.reason === "over-budget"));
  }
});

test("a zero-utility candidate is never selected", () => {
  const res = planPortfolio({
    ...base,
    candidates: [cand("zero", 5, 0, 1n, false)],
    mandatoryTokenEstimate: 0,
    tokenBudget: 100,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(res.plan.omissions.some((o) => o.reason === "zero-utility"));
});

test("a negative budget is rejected with PLN_INVALID_BUDGET", () => {
  const res = planPortfolio({
    ...base,
    candidates: [cand("m1", 10, 100, 1n, true)],
    mandatoryTokenEstimate: 10,
    tokenBudget: -1,
    framing: ZERO,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "PLN_INVALID_BUDGET");
});

test("the accepted plan token total never exceeds the budget", () => {
  const res = planPortfolio({
    ...base,
    candidates: [
      cand("hi", 10, 20, 1n, false),
      cand("mid", 10, 10, 2n, false),
      cand("lo", 10, 5, 3n, false),
    ],
    mandatoryTokenEstimate: 0,
    tokenBudget: 25,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(res.plan.tokenTotal <= 25);
});

test("mode B (greedy closed) admits both optional nodes in source order with no ratio, independent of A", () => {
  const candidates = [
    cand("hi", 10, 20, 2n, false),
    cand("lo", 10, 5, 1n, false),
  ];
  const res = planGreedyClosed({
    ...base,
    candidates,
    mandatoryTokenEstimate: 0,
    tokenBudget: 100,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    // Both fit (source order, no ratio): the selection is the FULL set, whereas
    // mode A would drop `lo` (lower ratio) under the same budget. The returned
    // ids are sorted by id bytes for a stable manifest.
    assert.deepEqual([...res.plan.selectedNodeIds], ["hi", "lo"]);
    assert.equal(res.plan.tokenTotal, 20);
  }
});

test("planManifestDigest is sensitive to a token-count mutation", () => {
  const candidates = [cand("m1", 10, 100, 1n, true), cand("m2", 20, 200, 2n, true)];
  const res = planPortfolio({
    ...base,
    candidates,
    mandatoryTokenEstimate: 30,
    tokenBudget: 100,
    framing: ZERO,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const pinned = planManifestDigest(res.plan, candidates);
  assert.equal(validatePlanManifest(res.plan, candidates, pinned).ok, true);
  const mutated = candidates.map((c, i) => (i === 0 ? { ...c, tokenEstimate: c.tokenEstimate + 1 } : c));
  const check = validatePlanManifest(res.plan, mutated, pinned);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.code, "PLN_MANIFEST_DIGEST_MISMATCH");
});
