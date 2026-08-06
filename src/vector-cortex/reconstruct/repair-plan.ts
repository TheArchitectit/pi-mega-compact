/**
 * vector-cortex/reconstruct/repair-plan.ts — VC6C-IMPL production repair plan seam.
 *
 * Maps a compact result into the production-facing plan the handler emits. The
 * pure `heal/repair-types.ts` contract stays the canonical design carrier; this
 * file owns the PRODUCTION shape (`RepairPlanV1` / `RepairEventV1`) that the
 * post-compact controller drives, plus the builder that turns a per-subsystem
 * gap into a plan.
 *
 * RELATIONSHIP TO heal/. The `heal/` modules (VC6C) already ship the pure
 * gap-detection / backoff / rebuild / switch primitives and 74 passing tests.
 * This sprint wires them into the production compact path; it does NOT fork
 * them. `buildRepairPlan` reuses `computeBackoff` for the deterministic
 * exponential delay (30s * 2^attempt, 15 min cap, ±10% SHA-256-derived jitter,
 * never `Math.random`) so a plan's `backoffMs` is byte-reproducible in a
 * fixture. Gap arithmetic mirrors `heal/controller.ts#gapRange`: the plan's seq
 * window is `derived post-count + 1 .. durable authority high-water`, inclusive,
 * exactly the unbuilt range.
 *
 * THE AUTHORITY IS NEVER WRITTEN. A plan carries `authorityHighWater` for
 * identity only; no code here (or anywhere in this sprint) mutates the durable
 * authority. `generation` is the NEW derived generation the rebuild writes into
 * (always `current + 1`), mirroring the heal copy-then-switch rule.
 *
 * PURE. `node:crypto` is used only transitively through `computeBackoff`; no
 * storage, no console, no clock of its own (`nowMs` is injected), no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import { computeBackoff } from "../heal/controller.js";
import type { Mode, RepairSubsystem } from "../heal/repair-types.js";

/**
 * Production repair plan: the exact shape the handler emits and the acceptance
 * fixture VC6C-IMPL-004 pins.
 *
 * `range` is a plain `[seqStart, seqEnd]` tuple (inclusive) — the production
 * handler deals in seq space, not byte shards, so the plan stays the cheap
 * operator-facing shape while `heal/repair-types.ts#RepairPlanV1.range` remains
 * the full `ShardRange` carrier for the pure controller.
 */
export interface RepairPlanV1 {
  readonly schema: "repair-plan-v1";
  /** The derived subsystem being repaired (e.g. "topology"). */
  readonly subsystem: RepairSubsystem;
  /** Inclusive seq window to rebuild: derived post-count + 1 .. authority. */
  readonly range: readonly [number, number];
  /** The NEW derived generation the rebuild materializes into. */
  readonly generation: number;
  /** Deterministic delay (ms) before the plan may execute. */
  readonly backoffMs: number;
}

/**
 * A repair lifecycle record emitted by the handler. Identity and counters only —
 * never a rebuilt byte, never a root digest of user content (SECURITY_PRIVACY).
 */
export interface RepairEventV1 {
  readonly schema: "repair-event-v1";
  readonly subsystem: RepairSubsystem;
  readonly kind: "planned" | "pointer-switched" | "backoff";
  readonly generation: number;
  readonly backoffMs: number;
  readonly code?: string;
}

/**
 * One subsystem's post-compact view used to build a plan. `postCount` is the
 * derived high-water (inclusive) AFTER compaction; `authorityHighWater` is the
 * durable contiguous authority frontier (inclusive), read-only.
 */
export interface PostCompactGap {
  readonly subsystem: RepairSubsystem;
  readonly postCount: number;
  readonly authorityHighWater: number;
  /** The CURRENT live generation; a plan targets `generation + 1`. */
  readonly generation: number;
  /** Consecutive failed attempts, the exponent in the exponential backoff. */
  readonly failedAttempts?: number;
  /** Which triad arm currently serves this subsystem. */
  readonly mode: Mode;
}

/**
 * The size of the gap (how many seq steps the derived tier fell behind the
 * authority), used for the `gapSize` event payload — derived from the plan
 * inputs, never a hardcoded literal.
 */
export function gapSizeOf(gap: PostCompactGap): number {
  return Math.max(0, gap.authorityHighWater - gap.postCount);
}

/**
 * Map one subsystem's post-compact gap into a production `RepairPlanV1`.
 *
 * Mirrors `heal/controller.ts#planRebuild`: the seq window is
 * `[postCount + 1, authorityHighWater]`, the generation targets `current + 1`,
 * and the backoff is the deterministic heal `computeBackoff`. No clock is read
 * here — the production shape carries no `scheduledAt`; the `nowMs`-injected
 * rate-limit/backoff decisions live in the heal controller (`detectGaps`), which
 * the handler drives with its own injected clock for reproducible fixtures.
 */
export function buildRepairPlan(gap: PostCompactGap): RepairPlanV1 {
  const backoffMs = computeBackoff(gap.subsystem, gap.failedAttempts ?? 0);
  return {
    schema: "repair-plan-v1",
    subsystem: gap.subsystem,
    range: [gap.postCount + 1, gap.authorityHighWater],
    generation: gap.generation + 1,
    backoffMs,
  };
}
