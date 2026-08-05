/**
 * rollout/live-chaos.test.ts — live graduated-rollout chaos (VC5C).
 *
 * Drives `decideLivePath` (the mega-runtime integration seam) under injected
 * clocks + hard faults, asserting the triad selection this seam actually
 * produces:
 *   A — VC path serves assigned buckets under the active gate;
 *   C — pre-VC path forced by a hard violation (causal/tool/anchor/exact) or by
 *       flag-off / missing evidence+clock.
 * The rollout seam never produces the deterministic-greedy "B" mode — it is a
 * pure gating layer with no live renderer driver, so a real mode-B fallback
 * belongs to the renderer-running layer, not here. Also asserts flag-OFF
 * degrades to mode C (byte-identical predecessor). No network, no Date.now in
 * the decision (PREVENT-PI-003/004 honored).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideLivePath } from "../../../extensions/mega-runtime/vector-cortex-live.js";
import type { RolloutClock, RolloutEvidence } from "./gate.js";
import type { GateIndex, RolloutHardFault } from "./types.js";

const FULL_WINDOW: RolloutEvidence = {
  windowStartMs: 0,
  powered: true,
  events: 10_000,
  sessions: 200,
  hardFaults: [],
};

function clock(delta: number): RolloutClock {
  return { now: () => delta, wallNow: () => new Date(delta).toISOString() };
}

describe("decideLivePath: triad selection (A when exposed, C otherwise)", () => {
  test("A — VC path serves assigned buckets under the active gate", () => {
    const d = decideLivePath("session-triad-a-0016", {
      clock: clock(72 * 60 * 60 * 1000),
      currentGate: 1 as GateIndex,
      evidence: FULL_WINDOW,
    });
    assert.equal(d.forcedPreVc, false);
    assert.equal(d.vcActive, true, "bucket qualifies at 5% gate");
    assert.equal(d.mode, "A");
  });

  test("C — a hard tool fault selects the pre-VC path and freezes promotion", () => {
    const faults: RolloutHardFault[] = [{ kind: "tool", detail: "trip" }];
    const d = decideLivePath("session-triad-b-0017", {
      clock: clock(72 * 60 * 60 * 1000),
      currentGate: 1 as GateIndex,
      evidence: FULL_WINDOW,
      hardFaults: faults,
    });
    assert.equal(d.forcedPreVc, true);
    assert.equal(d.promotionBlocked, true);
    assert.equal(d.mode, "C", "hard tool fault collapses to pre-VC continuity");
  });

  test("C — a hard exact violation forces the pre-VC path and freezes promotion", () => {
    const faults: RolloutHardFault[] = [{ kind: "exact", detail: "c-violation" }];
    const d = decideLivePath("session-triad-c-0018", {
      clock: clock(72 * 60 * 60 * 1000),
      currentGate: 2 as GateIndex,
      evidence: FULL_WINDOW,
      hardFaults: faults,
    });
    assert.equal(d.forcedPreVc, true);
    assert.equal(d.mode, "C");
    assert.equal(d.promotionBlocked, true);
  });
});

describe("decideLivePath: never emits role:system (PREVENT-PI-003)", () => {
  test("the systemPromptPrepend is always the empty string (host seat only)", () => {
    const d = decideLivePath("session-x", {
      clock: clock(72 * 60 * 60 * 1000),
      currentGate: 1 as GateIndex,
      evidence: FULL_WINDOW,
    });
    assert.equal(d.systemPromptPrepend, "", "never a role:system payload");
  });
});

describe("decideLivePath: flag-off byte-identical predecessor", () => {
  test("VC5C=0 degrades to mode C with VC path inactive", () => {
    const saved = process.env.MEGACOMPACT_VC5C;
    process.env.MEGACOMPACT_VC5C = "0";
    try {
      const d = decideLivePath("session-x", {
        clock: clock(72 * 60 * 60 * 1000),
        currentGate: 4 as GateIndex,
        evidence: FULL_WINDOW,
      });
      // Without the flag the seam returns mode C regardless of evidence.
      assert.equal(d.vcActive, false);
      assert.equal(d.mode, "C");
      assert.equal(d.promotionBlocked, false);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC5C;
      else process.env.MEGACOMPACT_VC5C = saved;
    }
  });
});
