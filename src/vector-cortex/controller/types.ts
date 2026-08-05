/**
 * controller/types.ts — VC8B policy decision + pressure type definitions.
 *
 * PolicyDecisionV1 is the FINITE, BOUNDED output of the policy engine: one of a
 * closed action set, a token budget clamped into a configured window, and a
 * machine code reason. There is deliberately no free-text field and no open
 * action string — an adaptive policy whose action space can grow at runtime
 * cannot be reviewed, and a budget with no ceiling is a cost incident waiting
 * to happen.
 *
 * PressureV2 canonicalizes the context-pressure label to EXACTLY five levels
 * (low/medium/high/ultra/mega). Anything else is rejected rather than coerced:
 * silently mapping an unrecognized legacy label onto a neighbouring level is
 * how a "high" workload quietly starts being treated as "low".
 *
 * Conformance IDs POL-001..025 and M7-001..015 are registered here as the
 * single source of truth for the sprint's conformance rows.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/** Schema version for PolicyDecisionV1. */
export const POLICY_DECISION_SCHEMA_V1 = "policy-decision-v1";

/** Schema version for PressureV2. */
export const PRESSURE_SCHEMA_V2 = "pressure-v2";

/** Failure code when a pressure label is outside the canonical five levels. */
export const POL_PRESSURE_UNKNOWN = "POL_PRESSURE_UNKNOWN";

/** Failure code when a requested action is outside the allowed finite set. */
export const POL_ACTION_FORBIDDEN = "POL_ACTION_FORBIDDEN";

/** Failure code when a budget bound pair is itself invalid (min > max, NaN). */
export const POL_BUDGET_OUT_OF_BOUNDS = "POL_BUDGET_OUT_OF_BOUNDS";

/** Failure code when the M7 migration meets a non-canonical pressure label. */
export const M7_PRESSURE_UNKNOWN = "M7_PRESSURE_UNKNOWN";

/** Failure code when M7 copied rows do not match the legacy row count. */
export const M7_COUNT_MISMATCH = "M7_COUNT_MISMATCH";

/** Failure code when an M7 row digest does not re-derive from its own fields. */
export const M7_DIGEST_MISMATCH = "M7_DIGEST_MISMATCH";

/** Failure code when the active pressure pointer is not on the legacy version. */
export const M7_NOT_ON_LEGACY = "M7_NOT_ON_LEGACY";

/**
 * The canonical five pressure levels. Ordered low -> mega; the order is
 * meaningful (policy escalates monotonically with pressure) so it is exported
 * as an array, not just a union.
 */
export const PRESSURE_LEVELS = [
  "low",
  "medium",
  "high",
  "ultra",
  "mega",
] as const;

/** A canonical context-pressure level. */
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

/**
 * The FINITE allowed policy action set. A decision may carry no other action.
 * `admit`    — proceed at the requested budget.
 * `dampen`   — proceed at a reduced budget (pressure is elevated).
 * `defer`    — postpone the work to a later turn.
 * `escalate` — raise the budget within bounds (headroom is available).
 * `reject`   — refuse the work outright.
 */
export const POLICY_ACTIONS = [
  "admit",
  "dampen",
  "defer",
  "escalate",
  "reject",
] as const;

/** An allowed policy action. */
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Machine reason codes — never free-text. */
export const POLICY_REASONS = [
  "within_bounds",
  "budget_clamped_low",
  "budget_clamped_high",
  "pressure_elevated",
  "pressure_critical",
  "headroom_available",
] as const;

/** A machine reason code explaining a decision. */
export type PolicyReason = (typeof POLICY_REASONS)[number];

/** The configured token-budget window a decision is clamped into. */
export interface PolicyBounds {
  readonly minBudget: number;
  readonly maxBudget: number;
}

/**
 * PolicyDecisionV1 — one bounded policy decision.
 * `budget` is ALWAYS within the bounds that produced it; `action` is always a
 * member of POLICY_ACTIONS.
 */
export interface PolicyDecisionV1 {
  readonly schema: typeof POLICY_DECISION_SCHEMA_V1;
  readonly decisionId: string;
  readonly sessionId: string;
  readonly action: PolicyAction;
  readonly budget: number;
  readonly pressure: PressureLevel;
  readonly reason: PolicyReason;
  readonly ts: string;
}

/** The input a policy evaluation consumes. */
export interface PolicyInput {
  readonly decisionId: string;
  readonly sessionId: string;
  /** The pressure label as received — validated, never coerced. */
  readonly pressure: string;
  /** The requested budget before clamping; any finite number. */
  readonly requestedBudget: number;
  readonly bounds: PolicyBounds;
  readonly ts: string;
}

/**
 * PressureV2 — a canonical pressure observation for a session at an effective
 * sequence point.
 */
export interface PressureV2 {
  readonly schema: typeof PRESSURE_SCHEMA_V2;
  readonly level: PressureLevel;
  readonly sessionId: string;
  readonly effectiveSeq: number;
  readonly ts: string;
}

/** Shadow metrics — counts only, never prompt bytes or free-text. */
export interface ShadowMetrics {
  /** Decisions evaluated in this shadow run. */
  readonly evaluated: number;
  /** Decisions whose budget was clamped at either bound. */
  readonly clamped: number;
  /** Inputs rejected (unknown pressure / bad bounds). */
  readonly rejected: number;
  /**
   * Live mutations performed by the shadow engine. Structurally ALWAYS 0 —
   * the shadow has no writer capability — and asserted as 0 by the sprint's
   * acceptance contract.
   */
  readonly liveMutations: number;
}

/** The result of a shadow evaluation: decisions + metrics ONLY. */
export interface ShadowResult {
  readonly decisions: ReadonlyArray<PolicyDecisionV1>;
  readonly rejections: ReadonlyArray<ShadowRejection>;
  readonly metrics: ShadowMetrics;
  /**
   * The digest of the canonical prompt as observed on entry. The shadow engine
   * re-computes this on exit and the two MUST be equal (POL-SHADOW-002).
   */
  readonly promptDigest: string;
}

/** A rejected shadow input, reduced to its code. */
export interface ShadowRejection {
  readonly decisionId: string;
  readonly code: string;
}

/** Conformance IDs POL-001..POL-025 for the 25 numbered policy rows. */
export const POLICY_CONFORMANCE_IDS: readonly string[] = Array.from(
  { length: 25 },
  (_v, i) => `POL-${String(i + 1).padStart(3, "0")}`,
);

/** Conformance IDs M7-001..M7-015 for the 15 numbered migration rows. */
export const M7_CONFORMANCE_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `M7-${String(i + 1).padStart(3, "0")}`,
);

/** Named conformance fixtures for the sprint's headline assertions. */
export const POLICY_NAMED_FIXTURES = [
  "POL-CLAMP-001",
  "POL-SHADOW-002",
  "M7-PRESSURE-003",
] as const;
