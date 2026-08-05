/**
 * heal/controller.test.ts — VC6C gap detection, planning, backoff, rate limit.
 *
 * Drives the REAL controller (no mocks): every case constructs genuine
 * `RepairState` objects and an explicit injected clock, which is the whole reason
 * `nowMs` is a parameter rather than a `Date.now()` read.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBackoff,
  createRepairController,
  detectGaps,
  isPlannable,
  isRateLimited,
  planRebuild,
} from "./controller.js";
import {
  REPAIR_BACKOFF_BASE_MS,
  REPAIR_BACKOFF_CAP_MS,
  REPAIR_BACKOFF_JITTER,
  REPAIR_RATE_LIMIT_MS,
  type RepairState,
} from "./repair-types.js";

const NOW = 1_000_000n;

function state(over: Partial<RepairState> = {}): RepairState {
  return {
    subsystem: "topology",
    derivedHighWater: 5n,
    authorityHighWater: 9n,
    lastRebuildAt: null,
    generation: 1,
    mode: "A",
    ...over,
  };
}

describe("VC6C detectGaps", () => {
  test("plans exactly the unbuilt window (derived+1 .. authority)", () => {
    const plans = detectGaps([state({ derivedHighWater: 8n, authorityHighWater: 10n })], NOW);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.range.seqStart, 9n);
    assert.equal(plans[0]!.range.seqEnd, 10n);
  });

  test("plans nothing when the derived source is level with authority", () => {
    assert.deepEqual(detectGaps([state({ derivedHighWater: 9n })], NOW), []);
  });

  test("a derived source AHEAD of authority never plans an inverted range", () => {
    const plans = detectGaps([state({ derivedHighWater: 12n, authorityHighWater: 9n })], NOW);
    assert.deepEqual(plans, []);
  });

  test("a one-seq gap plans a single-element window", () => {
    const plans = detectGaps([state({ derivedHighWater: 8n, authorityHighWater: 9n })], NOW);
    assert.equal(plans[0]!.range.seqStart, 9n);
    assert.equal(plans[0]!.range.seqEnd, 9n);
  });

  test("each lagging subsystem plans its own independent window", () => {
    const plans = detectGaps(
      [
        state({ subsystem: "topology", derivedHighWater: 5n, authorityHighWater: 9n }),
        state({ subsystem: "shards", derivedHighWater: 0n, authorityHighWater: 3n }),
        state({ subsystem: "closure", derivedHighWater: 7n, authorityHighWater: 8n }),
      ],
      NOW,
    );
    assert.deepEqual(
      plans.map((p) => [p.subsystem, p.range.seqStart, p.range.seqEnd]),
      [
        ["topology", 6n, 9n],
        ["shards", 1n, 3n],
        ["closure", 8n, 8n],
      ],
    );
  });

  test("output preserves INPUT order (caller owns priority, not the controller)", () => {
    const plans = detectGaps(
      [
        state({ subsystem: "zeta", derivedHighWater: 0n, authorityHighWater: 1n }),
        state({ subsystem: "alpha", derivedHighWater: 0n, authorityHighWater: 1n }),
      ],
      NOW,
    );
    assert.deepEqual(plans.map((p) => p.subsystem), ["zeta", "alpha"]);
  });

  test("targets generation+1 — a rebuild never writes into the live generation", () => {
    const plans = detectGaps([state({ generation: 7 })], NOW);
    assert.equal(plans[0]!.generation, 8);
  });

  test("an empty state list plans nothing and does not throw", () => {
    assert.deepEqual(detectGaps([], NOW), []);
  });
});

describe("VC6C refusal rules", () => {
  test("a frozen authority refuses to plan (derived lag is CORRECT in an outage)", () => {
    const frozen = state({ authorityFrozen: true });
    assert.equal(isPlannable(frozen, NOW), false);
    assert.deepEqual(detectGaps([frozen], NOW), []);
  });

  test("a frozen authority blocks only itself; healthy siblings still plan", () => {
    const plans = detectGaps(
      [
        state({ subsystem: "topology", authorityFrozen: true }),
        state({ subsystem: "shards", derivedHighWater: 1n, authorityHighWater: 4n }),
      ],
      NOW,
    );
    assert.deepEqual(plans.map((p) => p.subsystem), ["shards"]);
  });

  test("a mode-C subsystem (derived disabled) is never re-planned", () => {
    assert.deepEqual(detectGaps([state({ mode: "C" })], NOW), []);
  });

  test("freeze outranks rate limit — an outage is correctness, not pacing", () => {
    // Both conditions hold. The frozen check must win, so the subsystem is
    // unplannable for the CORRECTNESS reason rather than merely delayed.
    const both = state({ authorityFrozen: true, lastRebuildAt: NOW - 1000n });
    assert.equal(isPlannable(both, NOW), false);
  });
});

describe("VC6C isRateLimited", () => {
  test("a subsystem that never rebuilt is never rate limited", () => {
    assert.equal(isRateLimited(null, NOW), false);
  });

  test("a rebuild inside the 5-minute window is suppressed", () => {
    assert.equal(isRateLimited(NOW - 60_000n, NOW), true);
    assert.deepEqual(detectGaps([state({ lastRebuildAt: NOW - 60_000n })], NOW), []);
  });

  test("the window boundary is exclusive: exactly 5 minutes ago is allowed", () => {
    const boundary = NOW - BigInt(REPAIR_RATE_LIMIT_MS);
    assert.equal(isRateLimited(boundary, NOW), false);
    // One millisecond inside the window is still suppressed.
    assert.equal(isRateLimited(boundary + 1n, NOW), true);
  });

  test("a rebuild older than the window permits a fresh plan", () => {
    const old = NOW - BigInt(REPAIR_RATE_LIMIT_MS) - 1n;
    assert.equal(isRateLimited(old, NOW), false);
    assert.equal(detectGaps([state({ lastRebuildAt: old })], NOW).length, 1);
  });
});

describe("VC6C computeBackoff", () => {
  test("attempt 0 sits within ±10% of the 30s base", () => {
    const ms = computeBackoff("topology", 0);
    assert.ok(ms >= REPAIR_BACKOFF_BASE_MS * (1 - REPAIR_BACKOFF_JITTER));
    assert.ok(ms <= REPAIR_BACKOFF_BASE_MS * (1 + REPAIR_BACKOFF_JITTER));
  });

  test("is deterministic — the same inputs always yield the same delay", () => {
    for (const attempt of [0, 1, 5, 12]) {
      assert.equal(
        computeBackoff("topology", attempt),
        computeBackoff("topology", attempt),
        `attempt ${attempt} must be reproducible (no Math.random)`,
      );
    }
  });

  test("different subsystems desynchronize (no thundering herd)", () => {
    // Same attempt, different seeds -> different delays.
    assert.notEqual(computeBackoff("topology", 3), computeBackoff("shards", 3));
  });

  test("grows exponentially across attempts BELOW the cap", () => {
    // Each step doubles, so even a worst-case -10%/+10% jitter swing cannot make
    // the next attempt smaller. This only holds while BOTH attempts are under
    // the cap: 30s*2^5 = 960s already exceeds the 900s ceiling, so from attempt
    // 5 onward every delay saturates and only jitter separates them (that
    // saturation is asserted by the cap test below, not here).
    const lastUncapped = Math.floor(
      Math.log2(REPAIR_BACKOFF_CAP_MS / REPAIR_BACKOFF_BASE_MS),
    );
    assert.ok(lastUncapped >= 4, "sanity: there is a pre-cap region to check");
    for (let a = 0; a < lastUncapped; a++) {
      const lo = computeBackoff("topology", a);
      const hi = computeBackoff("topology", a + 1);
      assert.ok(hi > lo, `attempt ${a + 1} (${hi}) must exceed attempt ${a} (${lo})`);
    }
  });

  test("saturated attempts stay pinned at the cap rather than growing", () => {
    // Past saturation the delay must NOT keep doubling — that is the whole point
    // of the cap. Every attempt from 5 upward sits within the jitter band of the
    // 15-minute ceiling.
    const floor = REPAIR_BACKOFF_CAP_MS * (1 - REPAIR_BACKOFF_JITTER);
    const ceiling = REPAIR_BACKOFF_CAP_MS * (1 + REPAIR_BACKOFF_JITTER);
    for (const attempt of [5, 6, 10, 30]) {
      const ms = computeBackoff("topology", attempt);
      assert.ok(ms >= floor && ms <= ceiling, `attempt ${attempt} (${ms}) must sit at the cap`);
    }
  });

  test("saturates at the 15-minute cap and never exceeds it after jitter", () => {
    for (const attempt of [10, 20, 30, 1000]) {
      const ms = computeBackoff("topology", attempt);
      assert.ok(
        ms <= REPAIR_BACKOFF_CAP_MS * (1 + REPAIR_BACKOFF_JITTER),
        `attempt ${attempt} (${ms}) must respect the cap`,
      );
      assert.ok(Number.isFinite(ms), "backoff must never be Infinity/NaN");
    }
  });

  test("a huge attempt is clamped, never NaN (Infinity * jitter guard)", () => {
    const ms = computeBackoff("topology", Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isFinite(ms) && ms > 0, `got ${ms}`);
  });

  test("a negative attempt is clamped to 0 rather than shrinking the delay", () => {
    assert.equal(computeBackoff("topology", -5), computeBackoff("topology", 0));
  });

  test("the delay is an integer (JSON-exact, so a fixture can pin it)", () => {
    assert.equal(Number.isInteger(computeBackoff("topology", 2)), true);
  });
});

describe("VC6C planRebuild", () => {
  test("scheduledAt is now + backoff, so a plan is not instantly eligible", () => {
    const plan = planRebuild(state({ failedAttempts: 2 }), NOW);
    assert.equal(plan.scheduledAt, NOW + BigInt(plan.backoffMs));
  });

  test("a repeatedly failing subsystem waits longer each attempt", () => {
    const first = planRebuild(state({ failedAttempts: 0 }), NOW);
    const later = planRebuild(state({ failedAttempts: 4 }), NOW);
    assert.ok(later.backoffMs > first.backoffMs);
  });

  test("the plan carries the schema tag and the subsystem as range identity", () => {
    const plan = planRebuild(state(), NOW);
    assert.equal(plan.schema, "repair-plan-v1");
    assert.equal(plan.range.sessionId, "topology");
  });
});

describe("VC6C authority is read-only", () => {
  test("planning never mutates the state it was given", () => {
    const original = state({ derivedHighWater: 5n, authorityHighWater: 9n });
    const snapshot = JSON.stringify(original, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    detectGaps([original], NOW);
    planRebuild(original, NOW);
    const after = JSON.stringify(original, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    assert.equal(after, snapshot, "controller must not write to authority state");
  });
});

describe("VC6C controller surface", () => {
  test("createRepairController exposes the bound detect/plan pair", () => {
    const c = createRepairController();
    assert.equal(typeof c.detectGaps, "function");
    assert.equal(typeof c.planRebuild, "function");
    assert.equal(c.detectGaps([state()], NOW).length, 1);
  });
});
