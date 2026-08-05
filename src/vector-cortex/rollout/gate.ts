/**
 * vector-cortex/rollout/gate.ts — monotonic graduated-gate advance decision.
 *
 * A gate advances exactly ONE step only when ALL conjuncts hold:
 *   (elapsedWallClock >= 72h)  — measured on the MONOTONIC clock, not wall time
 *   AND (powered sample available)
 *   AND (events >= 10000)
 *   AND (sessions >= 200)
 *
 * Promotion is strictly monotonic by one gate step. The unique failure
 * injection (TRIAD_RESILIENCE.md): a wall-clock jump while the monotonic clock
 * is unchanged does NOT advance — because the 72h eligibility is the MONOTONIC
 * delta, not wall time. We therefore take an injected clock seam with SEPARATE
 * monotonic and wall readings and never call Date.now() directly for the safety
 * decision (PREVENT decorum: the host injects a testable fake clock).
 *
 * Pure arithmetic over injected evidence + clock; no I/O, no network.
 * PREVENT-011: no `any`.
 */

import {
  ROLLOUT_GATES,
  type GateIndex,
  type LiveOutcomeV1,
  type RolloutHardFault,
} from "./types.js";

/** The 72h monotonic residency requirement (milliseconds). */
export const GATE_MIN_ELAPSED_MS = 72 * 60 * 60 * 1000;
/** Powered-sample availability gate (minimum events for a one-sided CI read). */
export const GATE_MIN_EVENTS = 10_000;
/** Minimum distinct sessions before a gate may advance. */
export const GATE_MIN_SESSIONS = 200;

/**
 * Injected clock seam. `now()` is MONOTONIC time (fake-clock testable; never
 * wall time) — eligibility windows/cooldowns use it. `wallNow()` is wall time
 * used ONLY for records (the `decidedAt` field), never for eligibility.
 */
export interface RolloutClock {
  /** Monotonic milliseconds (e.g. process monotonic time, fake-clock testable). */
  now(): number;
  /** Wall-clock ISO-8601 string for records only. */
  wallNow(): string;
}

/** Default clock: real monotonic (performance.now) + wall (ISO). */
export function defaultClock(): RolloutClock {
  return {
    now: () => performance.now(),
    wallNow: () => new Date().toISOString(),
  };
}

/** Evidence observed in the current observation window. */
export interface RolloutEvidence {
  /** Monotonic start of the observation window (ms). */
  readonly windowStartMs: number;
  /** Whether a powered (statistically adequate) sample is available. */
  readonly powered: boolean;
  /** Total observed events in the window. */
  readonly events: number;
  /** Total distinct sessions observed in the window. */
  readonly sessions: number;
  /** Hard failures observed (any entry freezes promotion → select C). */
  readonly hardFaults: readonly RolloutHardFault[];
}

/**
 * Decide the next live outcome for a decision epoch. Returns the (possibly
 * advanced) gate index + the full evidence snapshot. Promotion monotonic by one
 * step; a hard fault freezes promotion (promotionBlocked=true) and is reported
 * for C-selection by the live seam.
 *
 * @param currentGate the gate index BEFORE this decision (0..4).
 * @param evidence the observed window evidence.
 * @param clock the injected monotonic/wall clock seam.
 */
export function decideGate(
  currentGate: GateIndex,
  evidence: RolloutEvidence,
  clock: RolloutClock,
): LiveOutcomeV1 {
  const elapsedMs = Math.max(0, clock.now() - evidence.windowStartMs);

  const hardFault = evidence.hardFaults.length > 0;
  const eligible =
    !hardFault &&
    currentGate < (ROLLOUT_GATES.length - 1) &&
    elapsedMs >= GATE_MIN_ELAPSED_MS &&
    evidence.powered &&
    evidence.events >= GATE_MIN_EVENTS &&
    evidence.sessions >= GATE_MIN_SESSIONS;

  // Monotonic by ONE step only.
  const nextGate: GateIndex = eligible
    ? ((currentGate + 1) as GateIndex)
    : currentGate;

  return {
    schema: "live-outcome-v1",
    gateIndex: nextGate,
    gatePct: ROLLOUT_GATES[nextGate]!,
    elapsedMs,
    powered: evidence.powered,
    events: evidence.events,
    sessions: evidence.sessions,
    promotionBlocked: hardFault,
    decidedAt: clock.wallNow(),
  };
}

/**
 * Whether a hard fault should SELECT triad C (pre-VC path). Any hard causal/
 * tool/anchor/exact failure does. Exposed so the live seam can branch cleanly.
 */
export function selectsPreVcPath(fault: RolloutHardFault | undefined): boolean {
  return fault !== undefined;
}
