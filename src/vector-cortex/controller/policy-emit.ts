/**
 * controller/policy-emit.ts — VC8B reporter seam (FLAG-GATED).
 *
 * Mirrors the VC8A outcomes-emit pattern: a thin `safe()` wrapper around an
 * optional injected `emit`, and the two event names the sprint spec requires:
 *   - `vector_cortex_shadow_decision_recorded` — a shadow decision was produced.
 *   - `vector_cortex_policy_action_rejected`   — an input was refused by policy.
 *
 * FLAG SEMANTICS. The policy/shadow/M7 arithmetic STILL RUNS regardless of
 * `MEGACOMPACT_VC8B`. The flag gates ONLY this reporting + dashboard seam:
 * flag-off is byte-identical to the predecessor (VC8A).
 *
 * PAYLOAD DISCIPLINE. These events carry only ids, the finite action, the
 * numeric budget, and machine codes — never prompt bytes, response text, or
 * free-text.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any` type.
 */

import { VC8B_ENABLED } from "../../config/vector-cortex.js";
import type { PolicyAction, PolicyReason, PressureLevel } from "./types.js";

/** The two structured events the VC8B reporter emits. */
export type PolicyEventName =
  | "vector_cortex_shadow_decision_recorded"
  | "vector_cortex_policy_action_rejected";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type PolicyEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: PolicyEmit | undefined, fn: (emit: PolicyEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** Report a shadow decision that was recorded. Gated by the flag. */
export function reportShadowDecisionRecorded(
  emit: PolicyEmit | undefined,
  decision: {
    readonly decisionId: string;
    readonly sessionId: string;
    readonly action: PolicyAction;
    readonly budget: number;
    readonly pressure: PressureLevel;
    readonly reason: PolicyReason;
  },
): void {
  if (!VC8B_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_shadow_decision_recorded", {
      ts: undefined,
      event: "vector_cortex_shadow_decision_recorded",
      decisionId: decision.decisionId,
      sessionId: decision.sessionId,
      action: decision.action,
      budget: decision.budget,
      pressure: decision.pressure,
      reason: decision.reason,
    }),
  );
}

/** Report a policy action rejected by validation. Gated by the flag. */
export function reportPolicyActionRejected(
  emit: PolicyEmit | undefined,
  rejection: { readonly decisionId: string; readonly code: string },
): void {
  if (!VC8B_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_policy_action_rejected", {
      ts: undefined,
      event: "vector_cortex_policy_action_rejected",
      decisionId: rejection.decisionId,
      code: rejection.code,
    }),
  );
}
