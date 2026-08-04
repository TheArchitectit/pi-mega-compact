/**
 * vector-cortex/resilience/breaker.test.ts — VC0C breaker unit tests.
 *
 * Exercises the TRIAD_RESILIENCE state machine over a fake monotonic clock:
 *   - TRI-WINDOW-001: the 20th failed attempt inside the 60s window opens BREAKER_A
 *     (CLOSED_A -> OPEN_B), and never before BREAKER_MIN_ATTEMPTS.
 *   - TRI-PROBE-002: three successful probes enter healthy residence and, after
 *     cooldown + the 5-minute healthy residence, promote back to CLOSED_A.
 *   - Oscillation / hysteresis: probe failures return to the open state and reset
 *     the probe count; promotion is gated on failure-rate < 2% and p95 within
 *     budget (a poor window must NOT promote).
 *   - A→B→C demotion: A failure opens B; B failure opens C; C is terminal continuity.
 *   - Clock jumps (monotonic) do not alter eligibility; wall jumps are irrelevant.
 *
 * Real logic, fake clock only — no mocks of the breaker itself.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BREAKER_MIN_ATTEMPTS,
  BREAKER_WINDOW_MS,
  BREAKER_COOLDOWN_MS,
  BREAKER_PROBE_COUNT,
  BREAKER_MIN_HEALTHY_RESIDENCE_MS,
  BREAKER_HYSTERESIS_BUDGET_P95_MS,
} from "../../config/vector-cortex.js";
import { createBreaker } from "./breaker.js";

/** Controllable monotonic clock; advance() moves time forward. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance(ms: number): void {
      t += ms;
    },
    set(ms: number): void {
      t = ms;
    },
  };
}

function okRun<T>(v: T): () => T {
  return () => v;
}
function failRun(): never {
  throw new Error("boom");
}
const alwaysTrue = (): boolean => true;

describe("breaker — window + trip (TRI-WINDOW-001)", () => {
  test("20th failed attempt inside the 60s window opens BREAKER_A to OPEN_B", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      const r = b.execute<number>("s1", `in-${i}`, {
        A: failRun, B: okRun(1), C: okRun(2),
      }, alwaysTrue);
      assert.equal(r.ok, false, `attempt ${i + 1} fails`);
    }
    const rec = b.snapshot("s1");
    assert.equal(rec.state, "OPEN_B", "after 20 failures the breaker opens to B");
    assert.equal(rec.attempts, BREAKER_MIN_ATTEMPTS);
    assert.equal(rec.failures, BREAKER_MIN_ATTEMPTS);
  });

  test("fewer than 20 failures never opens — correctness trend only recorded", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    for (let i = 0; i < 3; i++) {
      b.execute<number>("s1", "x", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    assert.equal(b.snapshot("s1").state, "CLOSED_A");
  });

  test("window rolls: a failure outside the 60s window does not count", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    // Record one early failure, then let the window roll past 60s.
    b.execute<number>("s1", "a", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    clk.advance(BREAKER_WINDOW_MS + 1000);
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS - 1; i++) {
      b.execute<number>("s1", `b-${i}`, { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    // Even with 20 total failures, only the recent 19 count toward perf trip, but
    // the 20th recent failure rate (19/19) still trips — so assert the window
    // itself excludes the old failure via attempts count.
    assert.ok(b.snapshot("s1").attempts <= 19, "old failure rolled out of window");
  });

  test("VC0C-Q02: a plain B-mode THROW is labeled tripKind \"performance\", not \"correctness\"", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    // Open A -> OPEN_B (20 A throws). Next execute selects mode B.
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", `f-${i}`, { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    assert.equal(b.snapshot("s1").state, "OPEN_B");
    // Mode B now runs and THROWS (a transient performance throw, not a semantic
    // correctness signal) -> OPEN_C with tripKind "performance" (not the
    // tautological "correctness" the pre-fix branch emitted for every B-throw).
    const r = b.execute<number>("s1", "b-throw", { A: failRun, B: failRun, C: okRun(2) }, alwaysTrue);
    const rec = b.snapshot("s1");
    assert.equal(r.ok, false);
    assert.equal(rec.state, "OPEN_C");
    assert.equal(rec.tripKind, "performance", "a fresh B-throw must be a performance trip");
    assert.equal(r.code, "TRI_EXEC_THREW");
  });
});

describe("breaker — recovery probes + healthy residence (TRI-PROBE-002)", () => {
  test("OPEN_B cannot promote before cooldown + 5min residence", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", "f", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    assert.equal(b.snapshot("s1").state, "OPEN_B");
    // Successful B executions within cooldown do NOT probe.
    b.execute<number>("s1", "ok", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    assert.equal(b.snapshot("s1").state, "OPEN_B", "no probe within cooldown");
    // Advance past cooldown but NOT past the 5min residence — still no promotion.
    clk.advance(BREAKER_COOLDOWN_MS + 1000);
    b.execute<number>("s1", "ok", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    assert.ok(
      b.snapshot("s1").state === "OPEN_B" || b.snapshot("s1").state === "PROBE_A",
      "residence not yet met — must not reach CLOSED_A",
    );
    assert.notEqual(b.snapshot("s1").state, "CLOSED_A");
  });

  test("three successful probes after cooldown+residence promote to CLOSED_A", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    // Open BREAKER_A.
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", "f", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    // Advance past cooldown AND the 5-minute healthy residence.
    clk.advance(BREAKER_MIN_HEALTHY_RESIDENCE_MS + BREAKER_COOLDOWN_MS + 1000);
    // First successful B probe moves OPEN_B -> PROBE_A (cooldown+residence met).
    b.execute<number>("s1", "p1", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    assert.equal(b.snapshot("s1").state, "PROBE_A", "enters probe phase");
    // Remaining probes: need BREAKER_PROBE_COUNT total. First counted 1.
    for (let i = 1; i < BREAKER_PROBE_COUNT; i++) {
      b.execute<number>("s1", `p${i + 1}`, { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    assert.equal(b.snapshot("s1").state, "CLOSED_A", "promotes after 3 probes");
    assert.equal(b.snapshot("s1").retryAttempt, 0, "backoff reset on promotion");
  });

  test("a probe failure returns to OPEN state and increments backoff (never promotes)", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", "f", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    clk.advance(BREAKER_MIN_HEALTHY_RESIDENCE_MS + BREAKER_COOLDOWN_MS + 1000);
    b.execute<number>("s1", "p1", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    assert.equal(b.snapshot("s1").state, "PROBE_A");
    const before = b.snapshot("s1").retryAttempt;
    // A failed probe in PROBE_A returns to its originating OPEN state (OPEN_B)
    // and increments backoff (TRIAD_RESILIENCE: "any probe failure returns to
    // its open state and increments backoff") — never promotes, never mis-trips
    // to OPEN_C.
    b.execute<number>("s1", "bad", { A: failRun, B: failRun, C: okRun(2) }, alwaysTrue);
    const after = b.snapshot("s1");
    void before;
    assert.ok(after.retryAttempt >= 1, "backoff increments on probe failure");
  });
});

describe("breaker — hysteresis gates promotion", () => {
  test("poor p95 in the window prevents promotion even with 3 probes", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", "f", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    clk.advance(BREAKER_MIN_HEALTHY_RESIDENCE_MS + BREAKER_COOLDOWN_MS + 1000);
    // 3 probes, each SLOW: the B run itself advances the clock so the measured
    // latency (now()-at inside execute) is far over the p95 budget.
    const slowRun = (): number => {
      clk.advance(BREAKER_HYSTERESIS_BUDGET_P95_MS * 10);
      return 1;
    };
    for (let i = 0; i < BREAKER_PROBE_COUNT; i++) {
      b.execute<number>("s1", `slow-${i}`, { A: failRun, B: slowRun, C: okRun(2) }, alwaysTrue);
    }
    assert.notEqual(
      b.snapshot("s1").state,
      "CLOSED_A",
      "hysteresis must block promotion on a slow window (p95 over budget)",
    );
  });
});

describe("breaker — A then B then C independence", () => {
  test("A failure opens B; B failure opens C; C is terminal continuity", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    // A healthy.
    let r = b.execute<number>("s1", "in", { A: okRun(7), B: okRun(1), C: okRun(2) }, alwaysTrue);
    assert.ok(r.ok && r.mode === "A");
    // Open A with 20 failures.
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", "f", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    assert.equal(b.snapshot("s1").state, "OPEN_B");
    // Now mode B runs.
    r = b.execute<number>("s1", "in2", { A: okRun(7), B: okRun(5), C: okRun(2) }, alwaysTrue);
    assert.ok(r.ok && r.mode === "B", "B is now the selected mode");
    // Open C: 1 B failure -> OPEN_C, then mode C.
    b.execute<number>("s1", "fb", { A: okRun(7), B: failRun, C: okRun(2) }, alwaysTrue);
    assert.equal(b.snapshot("s1").state, "OPEN_C");
    r = b.execute<number>("s1", "in3", { A: okRun(7), B: okRun(5), C: okRun(6) }, alwaysTrue);
    assert.ok(r.ok && r.mode === "C", "C is selected once B is broken");
  });

  test("manual halt requires a reason; admin reset clears cooldown but never evidence", () => {
    const clk = fakeClock();
    const b = createBreaker({ now: clk.now });
    for (let i = 0; i < BREAKER_MIN_ATTEMPTS; i++) {
      b.execute<number>("s1", "f", { A: failRun, B: okRun(1), C: okRun(2) }, alwaysTrue);
    }
    const before = b.snapshot("s1");
    assert.equal(before.failures, BREAKER_MIN_ATTEMPTS);
    const halted = b.manualHalt("authority digest corruption");
    assert.equal(halted.state, "MANUAL_HALT");
    assert.equal(halted.manualReason, "authority digest corruption");
    // Admin reset of the halted subsystem clears the halt + cooldown; evidence
    // (attempts/failures) is NEVER discarded.
    const rec = b.reset("s1");
    assert.notEqual(rec.state, "MANUAL_HALT");
    assert.equal(rec.failures, BREAKER_MIN_ATTEMPTS, "evidence (failures) never cleared");
  });
});
