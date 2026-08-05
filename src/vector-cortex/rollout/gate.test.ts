/**
 * rollout/gate.test.ts — monotonic graduated-gate advance decision (VC5C).
 *
 * Asserts: all conjuncts must hold to advance ONE gate; advancement is strictly
 * monotonic; and the unique failure injection — a wall-clock jump while the
 * monotonic clock is unchanged does NOT advance (eligibility uses the MONOTONIC
 * delta only, never wall time).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideGate,
  defaultClock,
  selectsPreVcPath,
  GATE_MIN_ELAPSED_MS,
  GATE_MIN_EVENTS,
  GATE_MIN_SESSIONS,
  type RolloutClock,
  type RolloutEvidence,
} from "./gate.js";
import type { GateIndex, RolloutHardFault } from "./types.js";

const FULL_WINDOW: RolloutEvidence = {
  windowStartMs: 0,
  powered: true,
  events: GATE_MIN_EVENTS,
  sessions: GATE_MIN_SESSIONS,
  hardFaults: [],
};

/** Monotonic clock pinned so `now()` returns `windowStart + delta`. */
function clock(delta: number, windowStart = 0): RolloutClock {
  return {
    now: () => windowStart + delta,
    wallNow: () => new Date(windowStart + delta).toISOString(),
  };
}

describe("decideGate: conjunctive advancement", () => {
  test("all conjuncts met advances exactly ONE gate step (0 -> 1)", () => {
    const out = decideGate(0, FULL_WINDOW, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 1);
    assert.equal(out.gatePct, 5);
    assert.equal(out.promotionBlocked, false);
  });

  test("already at 100% cannot advance further", () => {
    const out = decideGate(4 as GateIndex, FULL_WINDOW, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 4);
  });

  test("a powered sample is required", () => {
    const ev = { ...FULL_WINDOW, powered: false };
    const out = decideGate(0, ev, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 0, "blocked without powered sample");
  });

  test(">=10,000 events is required", () => {
    const ev = { ...FULL_WINDOW, events: GATE_MIN_EVENTS - 1 };
    const out = decideGate(0, ev, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 0, "blocked with 9999 events");
  });

  test(">=200 sessions is required", () => {
    const ev = { ...FULL_WINDOW, sessions: GATE_MIN_SESSIONS - 1 };
    const out = decideGate(0, ev, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 0, "blocked with 199 sessions");
  });

  test("72h monotonic residency is required (71h59m blocked)", () => {
    const out = decideGate(0, FULL_WINDOW, clock(GATE_MIN_ELAPSED_MS - 60_000));
    assert.equal(out.gateIndex, 0, "blocked at 71h59m");
  });
});

describe("decideGate: unique failure injection (wall-clock jump)", () => {
  test("a wall-clock jump (+1d) with UNCHANGED monotonic clock does NOT advance", () => {
    // Restart at 71h59m: monotonic elapsed is 71h59m (unchanged from a jump that
    // only touched wall time). The decision must remain blocked.
    const monotonicElapsed = GATE_MIN_ELAPSED_MS - 60_000;
    const out = decideGate(0, FULL_WINDOW, clock(monotonicElapsed));
    assert.equal(out.gateIndex, 0, "monotonic unchanged -> blocked");
    assert.equal(out.promotionBlocked, false);
  });

  test("a true monotonic delta >= 72h DOES advance (no wall jump needed)", () => {
    const out = decideGate(0, FULL_WINDOW, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 1, "monotonic 72h -> advance");
  });

  test("defaultClock yields a monotonically increasing now()", () => {
    const c = defaultClock();
    const a = c.now();
    const b = c.now();
    assert.ok(b >= a, "monotonic clock never goes backward");
  });
});

describe("decideGate: hard-fault freeze", () => {
  test("any hard fault freezes promotion and reports promotionBlocked", () => {
    const faults: RolloutHardFault[] = [{ kind: "tool", detail: "tool-pair-split" }];
    const ev = { ...FULL_WINDOW, hardFaults: faults };
    const out = decideGate(0, ev, clock(GATE_MIN_ELAPSED_MS));
    assert.equal(out.gateIndex, 0, "frozen at current gate");
    assert.equal(out.promotionBlocked, true);
  });

  test("selectsPreVcPath is true for any hard fault", () => {
    assert.equal(selectsPreVcPath({ kind: "causal", detail: "x" }), true);
    assert.equal(selectsPreVcPath(undefined), false);
  });
});
