/**
 * outcomes/emit.ts — VC8A reporter seam (FLAG-GATED).
 *
 * Mirrors the VC7C diagnostics-emit pattern: a thin `safe()` wrapper around an
 * optional injected `emit`, and the two event names the sprint spec requires:
 *   - `vector_cortex_outcome_appended` — an outcome was appended to the ledger.
 *   - `vector_cortex_dataset_record_excluded` — a row was excluded from a manifest.
 *
 * FLAG SEMANTICS. The ledger/consent/dataset arithmetic STILL RUNS regardless
 * of `MEGACOMPACT_VC8A`. The flag gates ONLY this reporting + dashboard seam:
 * flag-off is byte-identical to the predecessor (VC7C).
 *
 * PAYLOAD DISCIPLINE. These events carry only the outcomeId/sessionId codes
 * and aggregate counts — never prompt bytes, response text, or free-text.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any` type.
 */

import { VC8A_ENABLED } from "../../config/vector-cortex.js";

/** The two structured events the VC8A reporter emits. */
export type OutcomeEventName =
  | "vector_cortex_outcome_appended"
  | "vector_cortex_dataset_record_excluded";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type OutcomeEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: OutcomeEmit | undefined, fn: (emit: OutcomeEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** Report an outcome appended to the ledger. Gated by the flag. */
export function reportOutcomeAppended(
  emit: OutcomeEmit | undefined,
  outcome: { readonly outcomeId: string; readonly sessionId: string; readonly repoId: string },
): void {
  if (!VC8A_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_outcome_appended", {
      ts: undefined,
      event: "vector_cortex_outcome_appended",
      outcomeId: outcome.outcomeId,
      sessionId: outcome.sessionId,
      repoId: outcome.repoId,
    }),
  );
}

/** Report a row excluded from a dataset manifest. Gated by the flag. */
export function reportDatasetRecordExcluded(
  emit: OutcomeEmit | undefined,
  excluded: { readonly outcomeId: string; readonly reason: string },
): void {
  if (!VC8A_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_dataset_record_excluded", {
      ts: undefined,
      event: "vector_cortex_dataset_record_excluded",
      outcomeId: excluded.outcomeId,
      reason: excluded.reason,
    }),
  );
}
