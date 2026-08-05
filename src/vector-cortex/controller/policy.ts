/**
 * controller/policy.ts — VC8B bounded policy engine (PURE).
 *
 * Three guarantees, all structural rather than conventional:
 *
 *   1. FINITE ACTIONS. `evaluatePolicy` can only ever return a member of
 *      POLICY_ACTIONS. The action is chosen by a total function over the
 *      canonical pressure levels, so there is no path that invents one.
 *   2. BOUNDED BUDGETS. Every returned budget is clamped into
 *      `[minBudget, maxBudget]`. Clamping is applied AFTER the pressure-driven
 *      adjustment, never before — otherwise a dampen/escalate step could carry
 *      an in-bounds budget back out of bounds.
 *   3. UNKNOWN PRESSURE REJECTS. A label outside the canonical five is
 *      rejected as POL_PRESSURE_UNKNOWN. It is never coerced to a neighbour:
 *      quietly mapping an unrecognized label onto "low" would silently
 *      downgrade a workload that the caller believed was protected.
 *
 * Everything here is PURE: no clock, no storage, no network, no flag read. The
 * flag gates only the reporter seam in policy-emit.ts, which is why flag-off is
 * byte-identical to the predecessor.
 *
 * PREVENT-002/011/PI-004 honored.
 */

import type {
  PolicyAction,
  PolicyBounds,
  PolicyDecisionV1,
  PolicyInput,
  PolicyReason,
  PressureLevel,
} from "./types.js";
import {
  POLICY_ACTIONS,
  POLICY_DECISION_SCHEMA_V1,
  POL_ACTION_FORBIDDEN,
  POL_BUDGET_OUT_OF_BOUNDS,
  POL_PRESSURE_UNKNOWN,
  PRESSURE_LEVELS,
} from "./types.js";

/** A policy failure carrying a machine code (never free-text). */
export interface PolicyFailure {
  readonly code: string;
}

/** Construct a policy failure. */
function fail(code: string): PolicyFailure {
  return { code };
}

/** Type guard: is this a canonical pressure level? */
export function isPressureLevel(label: string): label is PressureLevel {
  return (PRESSURE_LEVELS as readonly string[]).includes(label);
}

/** Type guard: is this an allowed policy action? */
export function isPolicyAction(action: string): action is PolicyAction {
  return (POLICY_ACTIONS as readonly string[]).includes(action);
}

/**
 * Validate a pressure label against the canonical five. Throws
 * `{ code: POL_PRESSURE_UNKNOWN }` rather than coercing — see the module note.
 */
export function validatePressureLabel(label: string): PressureLevel {
  if (!isPressureLevel(label)) throw fail(POL_PRESSURE_UNKNOWN);
  return label;
}

/**
 * Validate an action against the allowed finite set. Throws
 * `{ code: POL_ACTION_FORBIDDEN }` for anything else.
 */
export function validateAction(action: string): PolicyAction {
  if (!isPolicyAction(action)) throw fail(POL_ACTION_FORBIDDEN);
  return action;
}

/**
 * Validate the bound pair itself. A window with min > max, or a non-finite
 * bound, has no correct clamp result, so it is rejected rather than guessed at.
 */
export function validateBounds(bounds: PolicyBounds): PolicyBounds {
  const { minBudget, maxBudget } = bounds;
  if (!Number.isFinite(minBudget) || !Number.isFinite(maxBudget)) {
    throw fail(POL_BUDGET_OUT_OF_BOUNDS);
  }
  if (minBudget > maxBudget) throw fail(POL_BUDGET_OUT_OF_BOUNDS);
  if (minBudget < 0) throw fail(POL_BUDGET_OUT_OF_BOUNDS);
  return bounds;
}

/**
 * Clamp a budget into `[minBudget, maxBudget]`.
 *
 * A NaN budget clamps to `minBudget`: NaN comparisons are all false, so a naive
 * Math.min/Math.max chain would propagate NaN straight through the "bounded"
 * guarantee. The safest interpretation of an unusable request is the floor.
 */
export function clampBudget(
  budget: number,
  minBudget: number,
  maxBudget: number,
): number {
  validateBounds({ minBudget, maxBudget });
  if (!Number.isFinite(budget)) return minBudget;
  if (budget < minBudget) return minBudget;
  if (budget > maxBudget) return maxBudget;
  return budget;
}

/** The multiplier applied to the requested budget at each pressure level. */
const PRESSURE_FACTOR: Readonly<Record<PressureLevel, number>> = {
  low: 1,
  medium: 1,
  high: 0.75,
  ultra: 0.5,
  mega: 0.25,
};

/**
 * The action selected at each pressure level. Total over PressureLevel, so the
 * action space cannot grow: `mega` refuses outright, `ultra` defers, `high`
 * dampens, and the quiet levels admit.
 */
const PRESSURE_ACTION: Readonly<Record<PressureLevel, PolicyAction>> = {
  low: "admit",
  medium: "admit",
  high: "dampen",
  ultra: "defer",
  mega: "reject",
};

/** Select the reason code that explains the decision. */
function reasonFor(
  pressure: PressureLevel,
  requested: number,
  clamped: number,
  bounds: PolicyBounds,
): PolicyReason {
  if (clamped === bounds.maxBudget && requested > bounds.maxBudget) {
    return "budget_clamped_high";
  }
  if (clamped === bounds.minBudget && requested < bounds.minBudget) {
    return "budget_clamped_low";
  }
  if (pressure === "mega" || pressure === "ultra") return "pressure_critical";
  if (pressure === "high") return "pressure_elevated";
  return "within_bounds";
}

/**
 * Evaluate one policy input into a bounded decision.
 *
 * Order matters: validate the label, validate the window, apply the
 * pressure factor, THEN clamp. Clamping last is what makes the bounded-budget
 * guarantee hold for every action including escalate.
 *
 * Throws `{ code }` on an unknown pressure label or an invalid bound pair.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecisionV1 {
  const pressure = validatePressureLabel(input.pressure);
  const bounds = validateBounds(input.bounds);

  const requested = Number.isFinite(input.requestedBudget)
    ? input.requestedBudget
    : bounds.minBudget;
  const adjusted = requested * PRESSURE_FACTOR[pressure];
  const budget = clampBudget(adjusted, bounds.minBudget, bounds.maxBudget);

  return {
    schema: POLICY_DECISION_SCHEMA_V1,
    decisionId: input.decisionId,
    sessionId: input.sessionId,
    action: PRESSURE_ACTION[pressure],
    budget,
    pressure,
    reason: reasonFor(pressure, adjusted, budget, bounds),
    ts: input.ts,
  };
}

/**
 * Assert a decision satisfies the sprint invariant: allowed action AND bounded
 * budget. Used by the acceptance aggregator to check every produced row.
 */
export function isDecisionWithinBounds(
  decision: PolicyDecisionV1,
  bounds: PolicyBounds,
): boolean {
  return (
    isPolicyAction(decision.action) &&
    Number.isFinite(decision.budget) &&
    decision.budget >= bounds.minBudget &&
    decision.budget <= bounds.maxBudget
  );
}
