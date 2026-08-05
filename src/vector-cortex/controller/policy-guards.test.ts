/**
 * controller/policy-guards.test.ts — VC8B policy validation + clamping tests.
 *
 * Pins the guard rails: clampBudget edge cases, pressure label validation,
 * action whitelist, and bound-pair validation. Uses the real production
 * module — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  clampBudget,
  isPolicyAction,
  isPressureLevel,
  validateAction,
  validateBounds,
  validatePressureLabel,
} from "./policy.js";
import type { PolicyBounds } from "./types.js";
import {
  POLICY_ACTIONS,
  POL_ACTION_FORBIDDEN,
  POL_BUDGET_OUT_OF_BOUNDS,
  POL_PRESSURE_UNKNOWN,
  PRESSURE_LEVELS,
} from "./types.js";

const BOUNDS: PolicyBounds = { minBudget: 100, maxBudget: 1000 };

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
