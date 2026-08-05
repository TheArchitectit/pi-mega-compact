/**
 * vector-cortex/heal/controller.ts — VC6C gap detection + rebuild planning.
 *
 * Compares each derived subsystem's high-water to the durable authority
 * high-water and emits a `RepairPlanV1` for every gap that is real, actionable,
 * and not rate-limited. The controller DECIDES; `rebuild.ts` executes.
 *
 * THE AUTHORITY IS NEVER WRITTEN. Every function here takes `RepairState` (whose
 * `authorityHighWater` is readonly) and returns plans. There is no code path,
 * guarded or otherwise, that mutates authority — derived state is rebuildable,
 * authority is not, so repair is strictly one-directional.
 *
 * FOUR REASONS NOT TO PLAN, in priority order. The order is the contract: a
 * frozen authority outranks a rate limit, because "the frontier is not real yet"
 * is a statement about CORRECTNESS while "you rebuilt recently" is only about
 * pacing. Reporting RATE_LIMITED during an outage would tell an operator to wait
 * five minutes for a rebuild that must never happen at all.
 *
 *   1. AUTHORITY FROZEN. During an outage the durable high-water freezes while
 *      the spool keeps accepting frames (TRIAD_RESILIENCE §frontier). A derived
 *      subsystem behind a frozen frontier is CORRECT, so we refuse to plan rather
 *      than chase the spool tail and materialize non-durable frames.
 *   2. NO GAP. `derived >= authority` — nothing to do. Note `>`: a derived source
 *      AHEAD of authority is not repaired by rebuilding a backwards range (that
 *      would produce an inverted range); it is left alone for the breaker.
 *   3. MODE C. Derived state is disabled for this subsystem. Re-planning a
 *      subsystem whose derived tier is intentionally off is a rebuild loop.
 *   4. RATE LIMITED. One rebuild per subsystem per 5 minutes.
 *
 * DETERMINISTIC JITTER. The ±10% spread comes from a SHA-256 of the subsystem
 * name plus the attempt, never `Math.random`. Two subsystems desynchronize (no
 * thundering herd) while a single subsystem's schedule is byte-reproducible — a
 * fixture can pin `backoffMs` exactly, which a PRNG would make untestable.
 *
 * PURE. `node:crypto` is the only dependency beyond types: no storage, no
 * console, no network, and no clock — `nowMs` is always injected, which is what
 * makes the fake-clock restart fixtures possible (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";

import type {
  RepairPlanV1,
  RepairState,
  RepairSubsystem,
  ShardRange,
} from "./repair-types.js";
import {
  REPAIR_BACKOFF_BASE_MS,
  REPAIR_BACKOFF_CAP_MS,
  REPAIR_BACKOFF_JITTER,
  REPAIR_RATE_LIMIT_MS,
} from "./repair-types.js";

/**
 * A stable fraction in [0,1) derived from the subsystem name + attempt.
 *
 * Uses the first 6 hex digits (24 bits) of SHA-256 — plenty of spread for a ±10%
 * window, and small enough to stay exact in a float64 division.
 */
function digestFraction(subsystem: RepairSubsystem, attempt: number): number {
  const hex = createHash("sha256")
    .update(`${subsystem}:${attempt}`)
    .digest("hex")
    .slice(0, 6);
  return parseInt(hex, 16) / 0x1000000;
}

/**
 * Deterministic exponential backoff: `30s * 2^attempt`, capped at 15 minutes,
 * then spread by ±10% seeded from the subsystem digest.
 *
 * The cap is applied BEFORE the jitter so the jitter is a spread around the cap
 * rather than a way to exceed it; the result is floored to an integer ms so the
 * value is exactly representable in JSON (a fixture pins it verbatim).
 *
 * `attempt` is clamped at 0 and at 30: `2^attempt` for an unclamped large attempt
 * would reach Infinity, and `Infinity * jitter` is NaN — a NaN backoff would
 * schedule a plan that is never eligible and silently wedge the subsystem.
 */
export function computeBackoff(subsystem: RepairSubsystem, attempt: number): number {
  const safe = Math.min(Math.max(Math.floor(attempt), 0), 30);
  const raw = REPAIR_BACKOFF_BASE_MS * 2 ** safe;
  const capped = Math.min(raw, REPAIR_BACKOFF_CAP_MS);
  // Map [0,1) onto [-1,+1) then scale to the ±10% window.
  const spread = (digestFraction(subsystem, safe) * 2 - 1) * REPAIR_BACKOFF_JITTER;
  return Math.max(0, Math.floor(capped * (1 + spread)));
}

/**
 * True when this subsystem rebuilt less than 5 minutes ago.
 *
 * A subsystem that has NEVER rebuilt (`lastRebuildAt === null`) is never rate
 * limited — the first repair after a restart must not be delayed by the absence
 * of history.
 */
export function isRateLimited(
  lastRebuildAt: bigint | null,
  nowMs: bigint,
): boolean {
  if (lastRebuildAt === null) return false;
  return lastRebuildAt + BigInt(REPAIR_RATE_LIMIT_MS) > nowMs;
}

/**
 * The seq window a rebuild must cover: the first UNBUILT seq through the
 * authority frontier, inclusive.
 *
 * Byte bounds are intentionally 0..0. VC6C plans in SEQ space — the controller
 * knows how far each derived tier has been built, but byte offsets belong to the
 * shard/ledger layer that executes the rebuild. Inventing byte bounds here would
 * be fabricating a fact the controller does not have.
 */
function gapRange(state: RepairState): ShardRange {
  return {
    sessionId: state.subsystem,
    seqStart: state.derivedHighWater + 1n,
    seqEnd: state.authorityHighWater,
    byteStart: 0,
    byteEnd: 0,
  };
}

/**
 * Build the plan for one subsystem's gap.
 *
 * Always targets `generation + 1`: a rebuild NEVER writes into the live
 * generation, so a failed or half-written rebuild cannot corrupt what is
 * currently being served (see `rebuild.ts` copy-then-switch).
 *
 * Exported for direct unit testing and for callers that have already decided a
 * plan is warranted; `detectGaps` is the guarded entry point that applies the
 * four refusal rules first.
 */
export function planRebuild(state: RepairState, nowMs: bigint): RepairPlanV1 {
  const backoffMs = computeBackoff(state.subsystem, state.failedAttempts ?? 0);
  return {
    schema: "repair-plan-v1",
    subsystem: state.subsystem,
    range: gapRange(state),
    generation: state.generation + 1,
    backoffMs,
    scheduledAt: nowMs + BigInt(backoffMs),
  };
}

/**
 * True when a subsystem is eligible for a rebuild plan (the four refusal rules).
 * Ordering matters — see the file header.
 */
export function isPlannable(state: RepairState, nowMs: bigint): boolean {
  if (state.authorityFrozen === true) return false;
  if (state.derivedHighWater >= state.authorityHighWater) return false;
  if (state.mode === "C") return false;
  if (isRateLimited(state.lastRebuildAt, nowMs)) return false;
  return true;
}

/**
 * Detect derived gaps and plan a rebuild for each eligible subsystem.
 *
 * Output order follows INPUT order, not subsystem name: the caller controls
 * priority (a topology gap may matter more than a closure gap), and re-sorting
 * here would silently override that. Never throws — an unplannable subsystem is
 * simply absent from the result, so a single wedged tier cannot stop the others
 * from healing (PRACTICES: non-fatal).
 */
export function detectGaps(
  states: readonly RepairState[],
  nowMs: bigint,
): readonly RepairPlanV1[] {
  const plans: RepairPlanV1[] = [];
  for (const state of states) {
    if (!isPlannable(state, nowMs)) continue;
    plans.push(planRebuild(state, nowMs));
  }
  return plans;
}

/**
 * The bound controller surface. A plain object (not a class): there is no
 * instance state to hold — every input, including the clock, is injected.
 */
export function createRepairController(): {
  readonly detectGaps: typeof detectGaps;
  readonly planRebuild: typeof planRebuild;
} {
  return { detectGaps, planRebuild };
}
