/**
 * vector-cortex/planner/manifest.ts — plan manifest identity + pre-provider
 * revalidation (VC5A).
 *
 * Split from `portfolio.ts` (which owns SELECTION) so each file keeps one
 * concern and stays under the 300-line soft limit: this module owns the plan's
 * IDENTITY and the last gate before a provider call.
 *
 * The manifest digest deliberately covers PER-NODE TOKEN COUNTS, which the DAG
 * digest does not: token counts are a planner input rather than DAG structure.
 * That is exactly what makes the sprint's unique failure injection detectable —
 * mutating a node's token count after planning but before validation changes the
 * recomputed manifest digest, so `validatePlanManifest` returns
 * `PLN_MANIFEST_DIGEST_MISMATCH` and the plan never reaches the provider.
 *
 * Pure/deterministic: no storage, no console, no network (PREVENT-PI-004).
 */

import { createHash } from "node:crypto";

import type { PlanCandidate, PlanV1 } from "./types.js";

/**
 * Deterministic digest over a plan AND the token counts/utilities it was
 * selected with. Hashing walks `selectedNodeIds` in its stored (sorted) order,
 * so the digest is a pure function of the plan and the candidate facts.
 *
 * A node missing from `candidates` hashes as `-1`, so dropping a candidate is
 * itself a detectable mutation rather than a silently-skipped field.
 */
export function planManifestDigest(
  plan: PlanV1,
  candidates: readonly PlanCandidate[],
): string {
  const h = createHash("sha256");
  h.update(plan.schema);
  h.update(" ");
  h.update(plan.dagDigest);
  h.update(" ");
  h.update(String(plan.tokenBudget));
  h.update(" ");
  h.update(String(plan.tokenTotal));
  h.update(" ");
  h.update(String(plan.dependencyHighWater));
  const byId = new Map(candidates.map((c) => [c.nodeId, c]));
  for (const id of plan.selectedNodeIds) {
    const c = byId.get(id);
    h.update("");
    h.update(id);
    h.update(" ");
    // Token count is part of the identity — a post-plan mutation breaks it.
    h.update(String(c?.tokenEstimate ?? -1));
    h.update(" ");
    h.update(String(c?.utility ?? -1));
  }
  return h.digest("hex");
}

/** The verdict of the pre-provider manifest revalidation. */
export type PlanManifestValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "PLN_MANIFEST_DIGEST_MISMATCH" };

/**
 * Re-validate a plan against the candidates AS THEY STAND NOW, immediately
 * before a provider call. Returns `PLN_MANIFEST_DIGEST_MISMATCH` when the
 * recomputed manifest digest disagrees with the digest pinned at planning time.
 *
 * This is the sprint's unique failure injection: a node token count mutated
 * after planning but before validation is caught here, BEFORE the provider is
 * invoked, rather than producing a prompt whose real cost differs from the
 * admitted budget.
 */
export function validatePlanManifest(
  plan: PlanV1,
  candidates: readonly PlanCandidate[],
  pinnedDigest: string,
): PlanManifestValidation {
  if (planManifestDigest(plan, candidates) !== pinnedDigest) {
    return { ok: false, code: "PLN_MANIFEST_DIGEST_MISMATCH" };
  }
  return { ok: true };
}
