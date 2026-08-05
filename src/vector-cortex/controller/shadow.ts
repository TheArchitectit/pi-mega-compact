/**
 * controller/shadow.ts — VC8B shadow policy evaluator (PURE, READ-ONLY).
 *
 * The shadow engine runs the candidate policy alongside the live path so its
 * decisions can be measured before they are trusted. That is only safe if the
 * shadow is structurally incapable of affecting the live path, so this module
 * takes the capability argument seriously:
 *
 *   - NO RENDERER. It imports no renderer and returns no rendered bytes.
 *   - NO STORE WRITER. It imports no store and performs no write.
 *   - NO PROMPT MUTATION. It receives the canonical prompt as bytes it may only
 *     hash, and it re-hashes on exit to PROVE the bytes are unchanged
 *     (POL-SHADOW-002). `liveMutations` is reported and is always 0.
 *
 * INPUTS ARE COPIED, NOT BORROWED. Every input is deep-copied on entry, so even
 * a future policy change that mutated its argument could not reach the caller's
 * object. The copy is the enforcement; the `readonly` types are only the
 * documentation of it. This is the difference between "we don't mutate" and
 * "we cannot mutate".
 *
 * A rejected input does NOT abort the run: the shadow's job is measurement, so
 * one unknown pressure label is recorded as a rejection code and the remaining
 * inputs are still evaluated.
 *
 * PREVENT-002/011/PI-004 honored.
 */

import { createHash } from "node:crypto";

import type {
  PolicyDecisionV1,
  PolicyInput,
  ShadowRejection,
  ShadowResult,
} from "./types.js";
import { evaluatePolicy } from "./policy.js";

/** SHA-256 of the canonical prompt bytes, lowercase hex (VC5B convention). */
export function promptDigestOf(promptBytes: string): string {
  return createHash("sha256")
    .update(Buffer.from(promptBytes, "utf8"))
    .digest("hex");
}

/**
 * Deep-copy one policy input. Explicit field-by-field construction rather than
 * a structured clone: it keeps the copy total over the declared shape and makes
 * an added field a compile error instead of a silently shared reference.
 */
export function copyPolicyInput(input: PolicyInput): PolicyInput {
  return {
    decisionId: input.decisionId,
    sessionId: input.sessionId,
    pressure: input.pressure,
    requestedBudget: input.requestedBudget,
    bounds: {
      minBudget: input.bounds.minBudget,
      maxBudget: input.bounds.maxBudget,
    },
    ts: input.ts,
  };
}

/** Extract the machine code from a thrown policy failure. */
function codeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "POL_UNKNOWN_FAILURE";
}

/**
 * Evaluate a batch of policy inputs in shadow mode.
 *
 * Returns decisions + metrics ONLY. The caller receives no capability to apply
 * any of it; promoting a shadow decision is a separate, explicit act.
 *
 * @param inputs      the policy inputs to evaluate (copied, never mutated)
 * @param promptBytes the canonical prompt, used ONLY to prove non-mutation
 */
export function evaluateShadow(
  inputs: readonly PolicyInput[],
  promptBytes: string,
): ShadowResult {
  // Hash the prompt BEFORE any evaluation so the exit comparison is meaningful.
  const digestOnEntry = promptDigestOf(promptBytes);

  // Copy every input up front: nothing downstream ever sees the caller's object.
  const copies = inputs.map(copyPolicyInput);

  const decisions: PolicyDecisionV1[] = [];
  const rejections: ShadowRejection[] = [];
  let clamped = 0;

  for (const copy of copies) {
    try {
      const decision = evaluatePolicy(copy);
      decisions.push(decision);
      const atBound =
        decision.reason === "budget_clamped_low" ||
        decision.reason === "budget_clamped_high";
      if (atBound) clamped += 1;
    } catch (err) {
      // Measurement continues: one bad row must not blind the whole run.
      rejections.push({ decisionId: copy.decisionId, code: codeOf(err) });
    }
  }

  // Re-hash on exit. Equality here is the POL-SHADOW-002 proof that the shadow
  // left the canonical prompt untouched.
  const digestOnExit = promptDigestOf(promptBytes);
  const promptUnchanged = digestOnEntry === digestOnExit;

  return {
    decisions,
    rejections,
    metrics: {
      evaluated: decisions.length,
      clamped,
      rejected: rejections.length,
      // Structurally zero: this module holds no writer capability. If the
      // prompt digest ever moved, that is a live mutation and it is counted.
      liveMutations: promptUnchanged ? 0 : 1,
    },
    promptDigest: digestOnExit,
  };
}

/**
 * Assert the shadow result carries no live mutation. The sprint's acceptance
 * bar is "shadow live mutation count zero"; this is that check as a function.
 */
export function isShadowClean(result: ShadowResult): boolean {
  return result.metrics.liveMutations === 0;
}
