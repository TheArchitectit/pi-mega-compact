/**
 * controller/policy.test.ts — VC8B policy engine evaluatePolicy tests.
 *
 * Pins the three structural guarantees for evaluatePolicy: finite actions,
 * bounded budgets, and unknown-pressure rejection. Guard-rail coverage
 * (clampBudget, validation, action whitelist, bound-pair validation) lives in
 * policy-guards.test.ts. Uses the real production module — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePolicy,
  isDecisionWithinBounds,
  isPolicyAction,
} from "./policy.js";
import type { PolicyBounds, PolicyInput } from "./types.js";
import {
  POLICY_DECISION_SCHEMA_V1,
  POL_BUDGET_OUT_OF_BOUNDS,
  POL_PRESSURE_UNKNOWN,
  PRESSURE_LEVELS,
} from "./types.js";

const BOUNDS: PolicyBounds = { minBudget: 100, maxBudget: 1000 };

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    decisionId: "dec-1",
    sessionId: "sess-1",
    pressure: "low",
    requestedBudget: 500,
    bounds: BOUNDS,
    ts: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Assert `fn` throws a failure carrying exactly `code`. */
function assertCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`expected a throw with code ${code}`);
  } catch (err) {
    assert.equal((err as { code?: string }).code, code);
  }
}

describe("VC8B evaluatePolicy", () => {
  test("every canonical pressure yields an allowed action and bounded budget", () => {
    for (const pressure of PRESSURE_LEVELS) {
      const decision = evaluatePolicy(input({ pressure }));
      assert.ok(
        isPolicyAction(decision.action),
        `${pressure} produced an allowed action`,
      );
      assert.ok(
        isDecisionWithinBounds(decision, BOUNDS),
        `${pressure} produced a bounded budget`,
      );
      assert.equal(decision.schema, POLICY_DECISION_SCHEMA_V1);
      assert.equal(decision.pressure, pressure);
    }
  });

  test("pressure selects the action deterministically", () => {
    const actionAt = (pressure: string): string =>
      evaluatePolicy(input({ pressure })).action;
    assert.equal(actionAt("low"), "admit");
    assert.equal(actionAt("medium"), "admit");
    assert.equal(actionAt("high"), "dampen");
    assert.equal(actionAt("ultra"), "defer");
    assert.equal(actionAt("mega"), "reject");
  });

  test("rising pressure never raises the budget", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const pressure of PRESSURE_LEVELS) {
      const { budget } = evaluatePolicy(input({ pressure }));
      assert.ok(budget <= previous, `${pressure} does not exceed the prior level`);
      previous = budget;
    }
  });

  test("the pressure factor is applied before clamping", () => {
    // 800 * 0.5 (ultra) = 400, comfortably inside the window.
    const decision = evaluatePolicy(
      input({ pressure: "ultra", requestedBudget: 800 }),
    );
    assert.equal(decision.budget, 400);
  });

  test("a dampened budget that falls under the floor is clamped up to it", () => {
    // 120 * 0.25 (mega) = 30, adjusted is below the 100 floor → budget_clamped_low.
    const decision = evaluatePolicy(
      input({ pressure: "mega", requestedBudget: 120 }),
    );
    assert.equal(decision.budget, 100);
    assert.equal(decision.reason, "budget_clamped_low");
    assert.ok(isDecisionWithinBounds(decision, BOUNDS));
  });

  test("an over-max request clamps and reports budget_clamped_high", () => {
    const decision = evaluatePolicy(input({ requestedBudget: 5000 }));
    assert.equal(decision.budget, 1000);
    assert.equal(decision.reason, "budget_clamped_high");
  });

  test("an under-min request clamps and reports budget_clamped_low", () => {
    const decision = evaluatePolicy(input({ requestedBudget: 1 }));
    assert.equal(decision.budget, 100);
    assert.equal(decision.reason, "budget_clamped_low");
  });

  test("an in-window low-pressure request reports within_bounds", () => {
    assert.equal(evaluatePolicy(input()).reason, "within_bounds");
  });

  test("elevated and critical pressure carry their reason codes", () => {
    assert.equal(
      evaluatePolicy(input({ pressure: "high" })).reason,
      "pressure_elevated",
    );
    // adjusted = 500 * 0.5 = 250 (in window) → pressure_critical
    assert.equal(
      evaluatePolicy(input({ pressure: "ultra" })).reason,
      "pressure_critical",
    );
    // adjusted = 500 * 0.25 = 125 (in window) → pressure_critical
    assert.equal(
      evaluatePolicy(input({ pressure: "mega" })).reason,
      "pressure_critical",
    );
    // adjusted = 200 * 0.5 = 100 = minBudget, lands exactly at floor → pressure_critical
    assert.equal(
      evaluatePolicy(input({ pressure: "ultra", requestedBudget: 200 })).reason,
      "pressure_critical",
    );
    // adjusted = 120 * 0.25 = 30 < minBudget → budget_clamped_low
    assert.equal(
      evaluatePolicy(input({ pressure: "mega", requestedBudget: 120 })).reason,
      "budget_clamped_low",
    );
  });

  test("an unknown pressure rejects the whole evaluation", () => {
    assertCode(
      () => evaluatePolicy(input({ pressure: "extreme" })),
      POL_PRESSURE_UNKNOWN,
    );
  });

  test("an invalid bound pair rejects the whole evaluation", () => {
    assertCode(
      () => evaluatePolicy(input({ bounds: { minBudget: 900, maxBudget: 100 } })),
      POL_BUDGET_OUT_OF_BOUNDS,
    );
  });

  test("a non-finite requested budget still yields a bounded decision", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = evaluatePolicy(input({ requestedBudget: bad }));
      assert.ok(
        isDecisionWithinBounds(decision, BOUNDS),
        `${String(bad)} still produced a bounded budget`,
      );
    }
  });

  test("arbitrary numeric budgets are ALWAYS bounded (invariant sweep)", () => {
    const budgets = [
      -1e9, -1, 0, 1, 99, 100, 101, 500, 999, 1000, 1001, 1e6, 1e9,
    ];
    for (const pressure of PRESSURE_LEVELS) {
      for (const requestedBudget of budgets) {
        const decision = evaluatePolicy(input({ pressure, requestedBudget }));
        assert.ok(
          isDecisionWithinBounds(decision, BOUNDS),
          `pressure=${pressure} budget=${requestedBudget} stayed in bounds`,
        );
      }
    }
  });

  test("evaluation is deterministic for identical input", () => {
    const a = evaluatePolicy(input({ pressure: "high", requestedBudget: 640 }));
    const b = evaluatePolicy(input({ pressure: "high", requestedBudget: 640 }));
    assert.deepEqual(a, b);
  });

  test("the caller's input object is not mutated", () => {
    const original = input({ pressure: "high", requestedBudget: 800 });
    const snapshot = JSON.stringify(original);
    evaluatePolicy(original);
    assert.equal(JSON.stringify(original), snapshot);
  });

  test("ids and timestamp are carried through verbatim", () => {
    const decision = evaluatePolicy(
      input({ decisionId: "dec-42", sessionId: "sess-9", ts: "2026-06-01T12:00:00Z" }),
    );
    assert.equal(decision.decisionId, "dec-42");
    assert.equal(decision.sessionId, "sess-9");
    assert.equal(decision.ts, "2026-06-01T12:00:00Z");
  });
});
