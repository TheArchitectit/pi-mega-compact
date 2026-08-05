/**
 * vector-cortex/rollout/types.ts — VC5C live graduated-rollout contracts.
 *
 * A session is deterministically hashed into one of 10,000 stable buckets
 * (0..9999). The current rollout gate is one of 1% / 5% / 25% / 50% / 100%.
 * A bucket is "in" the current gate iff `bucket < gatePct * 100`. Assignment is
 * a PURE function of the session id: it NEVER changes across process restart
 * (no Date.now / Math.random — see `assign.ts`).
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

/** Total stable buckets. Reassignment on restart is impossible by construction. */
export const ROLLOUT_BUCKETS = 10_000;

/**
 * The five graduated gates, in promotion order. Index = step. Promotion is
 * strictly monotonic by ONE step (never skipping a gate).
 */
export const ROLLOUT_GATES: readonly number[] = [1, 5, 25, 50, 100];

/** The current gate index (0 = 1%, 4 = 100%). */
export type GateIndex = 0 | 1 | 2 | 3 | 4;

/**
 * A rollout assignment: the stable bucket + the gate it currently qualifies for.
 * `bucket` is fixed for the life of the session; `gateIndex` is the highest gate
 * whose bucket bound the session falls under AT the decision epoch.
 */
export interface RolloutAssignmentV1 {
  readonly schema: "rollout-assignment-v1";
  /** Session id the assignment was derived from. */
  readonly sessionId: string;
  /** Stable bucket in 0..9999 (deterministic, restart-invariant). */
  readonly bucket: number;
  /** Current highest gate the bucket qualifies for (0..4). */
  readonly gateIndex: GateIndex;
}

/**
 * The live outcome of a rollout decision epoch: the current gate, the evidence
 * counts observed, and whether promotion to the next gate is BLOCKED (hard
 * failure froze promotion).
 */
export interface LiveOutcomeV1 {
  readonly schema: "live-outcome-v1";
  /** Current gate index (0..4). */
  readonly gateIndex: GateIndex;
  /** Current gate percentage (ROLLOUT_GATES[gateIndex]). */
  readonly gatePct: number;
  /** Monotonic wall-elapsed milliseconds in the observation window. */
  readonly elapsedMs: number;
  /** Whether a powered (statistically adequate) sample is available. */
  readonly powered: boolean;
  /** Total observed events in the window. */
  readonly events: number;
  /** Total distinct sessions observed in the window. */
  readonly sessions: number;
  /** True when a hard causal/tool/anchor/exact failure froze promotion. */
  readonly promotionBlocked: boolean;
  /** ISO-8601 timestamp of the decision (records only; never drives eligibility). */
  readonly decidedAt: string;
}

/**
 * Failure class that, on a hard occurrence, selects triad C (pre-VC path) and
 * freezes promotion. These are the only classes that can freeze the rollout.
 */
export type RolloutHardFailure =
  | "causal"
  | "tool"
  | "anchor"
  | "exact";

/** A hard failure observation (drives the C selection + promotion freeze). */
export interface RolloutHardFault {
  readonly kind: RolloutHardFailure;
  readonly detail: string;
}

/**
 * The two conformance events VC5C emits to the monitoring/events path. Mirrors
 * how prior sprints emit (resilience/emit.ts, render/emit.ts).
 */
export const ROLLOUT_EVENTS = [
  "vector_cortex_rollout_assigned",
  "vector_cortex_rollout_promotion_blocked",
] as const;

export type RolloutEvent = (typeof ROLLOUT_EVENTS)[number];

/** Emitter signature (structural match to prior sprints' `RenderEmitter`). */
export type RolloutEmitter = (event: string, fields: Record<string, unknown>) => void;

/**
 * Registered rollout conformance ID range (ROL-001..020). The acceptance
 * aggregator reads these rows from the v2 manifest and asserts each returns its
 * manifest `ok`/`code`.
 */
export const ROL_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_v, i) => `ROL-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC5C rollout conformance assertions (the sprint's headline rows). */
export const ROL_NAMED_IDS = [
  "ROL-BUCKET-001",
  "ROL-POWER-002",
  "ROL-SAFETY-003",
] as const;
