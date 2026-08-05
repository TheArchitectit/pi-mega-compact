/**
 * controller/policy.test.ts — VC8B policy engine tests.
 *
 * Pins the three structural guarantees: finite actions, bounded budgets, and
 * unknown-pressure rejection. Uses the real production module — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  clampBudget,
  evaluatePolicy,
  isDecisionWithinBounds,
  isPolicyAction,
  isPressureLevel,
  validateAction,
  validateBounds,
  validatePressureLabel,
} from "./policy.js";
import type { PolicyBounds, PolicyInput } from "./types.js";
import {
  POLICY_ACTIONS,
  POLICY_DECISION_SCHEMA_V1,
  POL_ACTION_FORBIDDEN,
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

describe("VC8B clampBudget", () => {
  test("POL-CLAMP-001: below-min and above-max budgets clamp exactly", () => {
    assert.equal(clampBudget(1, 100, 1000), 100, "below min clamps to min");
    assert.equal(clampBudget(99_999, 100, 1000), 1000, "above max clamps to max");
  });

  test("a budget inside the window passes through unchanged", () => {
    assert.equal(clampBudget(500, 100, 1000), 500);
  });

  test("the bounds themselves are inclusive", () => {
    assert.equal(clampBudget(100, 100, 1000), 100);
    assert.equal(clampBudget(1000, 100, 1000), 1000);
  });

  test("a degenerate window (min === max) pins every budget to that value", () => {
    assert.equal(clampBudget(0, 500, 500), 500);
    assert.equal(clampBudget(10_000, 500, 500), 500);
  });

  test("NaN clamps to min rather than propagating through the bound check", () => {
    // A naive Math.min/Math.max chain returns NaN here, silently breaking the
    // bounded-budget guarantee.
    assert.equal(clampBudget(Number.NaN, 100, 1000), 100);
  });

  test("infinities clamp to the window, never escape it", () => {
    assert.equal(clampBudget(Number.POSITIVE_INFINITY, 100, 1000), 100);
    assert.equal(clampBudget(Number.NEGATIVE_INFINITY, 100, 1000), 100);
  });

  test("an inverted window is rejected, not silently swapped", () => {
    assertCode(() => clampBudget(500, 1000, 100), POL_BUDGET_OUT_OF_BOUNDS);
  });

  test("a negative minimum is rejected", () => {
    assertCode(() => clampBudget(500, -1, 1000), POL_BUDGET_OUT_OF_BOUNDS);
  });

  test("non-finite bounds are rejected", () => {
    assertCode(() => clampBudget(5, Number.NaN, 1000), POL_BUDGET_OUT_OF_BOUNDS);
    assertCode(
      () => clampBudget(5, 100, Number.POSITIVE_INFINITY),
      POL_BUDGET_OUT_OF_BOUNDS,
    );
  });
});

describe("VC8B pressure validation", () => {
  test("all five canonical levels validate", () => {
    for (const level of PRESSURE_LEVELS) {
      assert.equal(validatePressureLabel(level), level);
      assert.ok(isPressureLevel(level));
    }
  });

  test("an unknown label rejects as POL_PRESSURE_UNKNOWN, never coerced", () => {
    for (const bad of ["", "LOW", "extreme", "critical", "none", "medium "]) {
      assertCode(() => validatePressureLabel(bad), POL_PRESSURE_UNKNOWN);
      assert.equal(isPressureLevel(bad), false, `${bad} is not canonical`);
    }
  });
});

describe("VC8B action validation", () => {
  test("every allowed action validates", () => {
    for (const action of POLICY_ACTIONS) {
      assert.equal(validateAction(action), action);
      assert.ok(isPolicyAction(action));
    }
  });

  test("an action outside the finite set is forbidden", () => {
    for (const bad of ["", "allow", "deny", "ADMIT", "drop"]) {
      assertCode(() => validateAction(bad), POL_ACTION_FORBIDDEN);
    }
  });
});

describe("VC8B validateBounds", () => {
  test("a well-formed window is returned unchanged", () => {
    assert.deepEqual(validateBounds(BOUNDS), BOUNDS);
  });

  test("min === max is a legal (degenerate) window", () => {
    assert.deepEqual(
      validateBounds({ minBudget: 5, maxBudget: 5 }),
      { minBudget: 5, maxBudget: 5 },
    );
  });
});

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
    // 120 * 0.25 (mega) = 30, which is below the 100 floor.
    const decision = evaluatePolicy(
      input({ pressure: "mega", requestedBudget: 120 }),
    );
    assert.equal(decision.budget, 100);
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
    for (const pressure of ["ultra", "mega"]) {
      assert.equal(
        evaluatePolicy(input({ pressure })).reason,
        "pressure_critical",
      );
    }
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
