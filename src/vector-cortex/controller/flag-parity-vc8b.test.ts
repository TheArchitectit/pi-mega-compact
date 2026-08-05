/**
 * controller/flag-parity-vc8b.test.ts — VC8B feature-flag parity contract.
 *
 * The flag `MEGACOMPACT_VC8B` gates ONLY the reporter/dashboard seam. The
 * policy evaluation, shadow metrics, and M7 migration are PURE and
 * flag-independent: flag-off is byte-identical to the predecessor (VC8A).
 *
 * This suite pins that contract:
 *   - flag ON  -> the emitter receives BOTH events (recorded + rejected).
 *   - flag OFF -> the emitter receives NEITHER.
 *   - the emitted payload is free of prompt/text (boundary-safe).
 *   - a throwing emitter is non-fatal; an absent emitter is a silent no-op.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  reportPolicyActionRejected,
  reportShadowDecisionRecorded,
} from "./policy-emit.js";

function withVc8bFlag(value: "0" | "1", fn: () => void): void {
  const prev = process.env["MEGACOMPACT_VC8B"];
  process.env["MEGACOMPACT_VC8B"] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["MEGACOMPACT_VC8B"];
    else process.env["MEGACOMPACT_VC8B"] = prev;
  }
}

type Emitted = { name: string; payload: unknown };
function recorder(): { emit: (name: string, payload: unknown) => void; seen: Emitted[] } {
  const seen: Emitted[] = [];
  return { emit: (name, payload) => seen.push({ name, payload }), seen };
}

describe("VC8B flag parity", () => {
  test("flag ON emits the shadow_decision_recorded event", () => {
    withVc8bFlag("1", () => {
      const { emit, seen } = recorder();
      reportShadowDecisionRecorded(emit, {
        decisionId: "d-1",
        sessionId: "s-1",
        action: "dampen",
        budget: 400,
        pressure: "high",
        reason: "pressure_elevated",
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].name, "vector_cortex_shadow_decision_recorded");
    });
  });

  test("flag ON emits the policy_action_rejected event", () => {
    withVc8bFlag("1", () => {
      const { emit, seen } = recorder();
      reportPolicyActionRejected(emit, {
        decisionId: "d-2",
        code: "POL_PRESSURE_UNKNOWN",
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].name, "vector_cortex_policy_action_rejected");
    });
  });

  test("flag OFF emits neither event", () => {
    withVc8bFlag("0", () => {
      const { emit, seen } = recorder();
      reportShadowDecisionRecorded(emit, {
        decisionId: "d-1",
        sessionId: "s-1",
        action: "admit",
        budget: 500,
        pressure: "low",
        reason: "within_bounds",
      });
      reportPolicyActionRejected(emit, {
        decisionId: "d-2",
        code: "POL_PRESSURE_UNKNOWN",
      });
      assert.equal(seen.length, 0);
    });
  });

  test("flag OFF suppresses each event individually", () => {
    withVc8bFlag("0", () => {
      const { emit, seen } = recorder();
      reportPolicyActionRejected(emit, {
        decisionId: "d-3",
        code: "POL_BUDGET_OUT_OF_BOUNDS",
      });
      assert.equal(seen.length, 0);
    });
  });

  test("the emitted payload never carries prompt/text/free-content", () => {
    withVc8bFlag("1", () => {
      const { emit, seen } = recorder();
      reportShadowDecisionRecorded(emit, {
        decisionId: "d-1",
        sessionId: "s-1",
        action: "defer",
        budget: 100,
        pressure: "ultra",
        reason: "pressure_critical",
      });
      const json = JSON.stringify(seen[0].payload);
      for (const leak of ["prompt", "response", "freeText", "exactBytes", "content", "text", "body", "message", "payload"]) {
        assert.ok(!json.includes(`"${leak}"`), `never exposes ${leak}`);
      }
    });
  });

  test("a throwing emitter is non-fatal", () => {
    withVc8bFlag("1", () => {
      const throwingEmit = () => {
        throw new Error("boom");
      };
      // Must not throw.
      reportShadowDecisionRecorded(throwingEmit, {
        decisionId: "d-1",
        sessionId: "s-1",
        action: "admit",
        budget: 500,
        pressure: "low",
        reason: "within_bounds",
      });
      reportPolicyActionRejected(throwingEmit, {
        decisionId: "d-2",
        code: "POL_PRESSURE_UNKNOWN",
      });
    });
  });

  test("an absent emitter is a silent no-op", () => {
    withVc8bFlag("1", () => {
      // Must not throw.
      reportShadowDecisionRecorded(undefined, {
        record: "bad", // should be ignored
      } as never);
      reportPolicyActionRejected(undefined, {
        record: "bad",
      } as never);
    });
  });
});
