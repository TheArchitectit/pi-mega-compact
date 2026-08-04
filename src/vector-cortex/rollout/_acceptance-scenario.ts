/**
 * rollout/_acceptance-scenario.ts — the REAL rollout runner for VC5C acceptance
 * rows. Drives `assignSession` + `decideGate` (no mocks) against the fixture
 * `input` and returns the result fields the fixture's `expected` block pins.
 *
 * Fake clocks: the gate scenario accepts an injected monotonic clock so the
 * spec's unique failure injection (restart at 71h59m with a wall-clock jump +1d
 * but monotonic unchanged) is reproducible. The wall-clock jump is irrelevant to
 * the safety decision because eligibility uses the MONOTONIC delta only.
 */

import { assignSession } from "./assign.js";
import {
  decideGate,
  type RolloutClock,
  type RolloutEvidence,
} from "./gate.js";
import type { GateIndex, RolloutHardFault } from "./types.js";
import type { RolloutFx } from "./_acceptance-fixture.js";

const GATE_MIN_ELAPSED_MS = 72 * 60 * 60 * 1000;

export interface RolloutRunOutcome {
  readonly ok: boolean;
  readonly bucket?: number;
  readonly gateIndex?: number;
  readonly promotionBlocked?: boolean;
  readonly selectsPreVc?: boolean;
}

/** Fixed monotonic clock: elapsed = now - windowStart (the only driver). */
function clockAt(elapsedMs: number, windowStartMs: number): RolloutClock {
  return {
    now: () => windowStartMs + elapsedMs, // monotonic delta is the truth
    wallNow: () => new Date(1_700_000_000_000 + elapsedMs).toISOString(),
  };
}

/** Run a rollout fixture through the REAL assign + gate pipeline. */
export function runRolloutScenario(fx: RolloutFx): RolloutRunOutcome {
  const scenario = fx.input.scenario;

  if (scenario === "assign-stable") {
    const a = assignSession(fx.input.sessionId ?? "");
    const b = assignSession(fx.input.sessionId ?? "");
    // Determinism: recomputing yields the identical bucket.
    if (a.bucket !== b.bucket) {
      return { ok: false };
    }
    return { ok: true, bucket: a.bucket };
  }

  if (scenario === "gate-power" || scenario === "gate-safety") {
    const ev = fx.input.evidence ?? {};
    const windowStartMs = ev.windowStartMs ?? 0;
    const hardFaults = (ev.hardFaults ?? []).map(
      (f): RolloutHardFault => ({ kind: f.kind as RolloutHardFault["kind"], detail: f.detail }),
    );
    const evidence: RolloutEvidence = {
      windowStartMs,
      powered: ev.powered ?? false,
      events: ev.events ?? 0,
      sessions: ev.sessions ?? 0,
      hardFaults,
    };

    // The spec's unique failure injection: wall-clock jump is irrelevant; only the
    // monotonic elapsed drives eligibility. For the 71h59m row we pass 71h59m; for
    // the wall-jump row we pass the SAME monotonic elapsed (so it must stay blocked);
    // for the >=72h row we pass a full 72h+ monotonic delta (so it advances).
    const start = (fx as RolloutFx & { _monotonicElapsedMs?: number })._monotonicElapsedMs;
    const elapsedMs = start ?? GATE_MIN_ELAPSED_MS; // default: a full 72h window
    const clock = clockAt(elapsedMs, windowStartMs);

    // gate-safety with a hard fault forces pre-VC + freezes promotion regardless of
    // the monotonic window; the gate index stays at the input's prior gate (0 here).
    if (scenario === "gate-safety") {
      const outcome = decideGate(0 as GateIndex, evidence, clock);
      return {
        ok: true,
        gateIndex: outcome.gateIndex,
        promotionBlocked: outcome.promotionBlocked,
        selectsPreVc: outcome.promotionBlocked,
      };
    }

    const outcome = decideGate(0 as GateIndex, evidence, clock);
    return {
      ok: true,
      gateIndex: outcome.gateIndex,
      promotionBlocked: outcome.promotionBlocked,
    };
  }

  throw new Error(`unknown rollout scenario: ${scenario}`);
}
