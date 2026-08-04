/**
 * vector-cortex/heal/emit.ts — VC6A event reporter seam (task 5).
 *
 * Mirrors `../rollout/emit.ts`: a thin `safe()` wrapper around an optional
 * injected `emit` (so unit tests stay pure — they pass `undefined` and inspect
 * nothing), and two event names required verbatim by the sprint spec:
 *   - `vector_cortex_closure_optimized`   — emitted when a proof is produced.
 *   - `vector_cortex_closure_proof_rejected` — emitted when verification fails.
 *
 * FLAG SEMANTICS (the invariant VC5B/VC5C established). The optimizer and
 * verifier are PURE arithmetic and run REGARDLESS of the flag. The flag gates
 * ONLY the reporting + dashboard seam: when `MEGACOMPACT_VC6A=0` we still compute
 * the proof (needed for byte-identical parity with the predecessor), we just do
 * not emit the VC6A-namespaced events. This is what makes flag-off byte-identical
 * to VC5C — the arithmetic is never skipped, only the announcement.
 *
 * No console, no storage, no network (PREVENT-PI-004 / PREVENT-011). Every line
 * is a structured JSON event with `ts` + `event`.
 */

import { VC6A_ENABLED } from "../../config/vector-cortex.js";
import type { HealEventName } from "./types.js";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type HealEmit = (name: string, payload: unknown) => void;

/**
 * Run `fn` only when an emit is available, swallowing and logging nothing on
 * failure (PRACTICES: non-fatal stores). `fn` receives the emit so callers need
 * not null-check.
 */
function safe(emit: HealEmit | undefined, fn: (emit: HealEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** The event names VC6A emits, exported for the dashboard seam and tests. */
export const HEAL_EVENT_NAMES: readonly HealEventName[] = [
  "vector_cortex_closure_optimized",
  "vector_cortex_closure_proof_rejected",
] as const;

/**
 * Report a successful optimization. `MEGACOMPACT_VC6A=0` suppresses the VC6A
 * event (flag-off parity) but does not affect the computation that produced
 * `proof`.
 */
export function reportClosureOptimized(
  emit: HealEmit | undefined,
  payload: {
    readonly sessionId: string;
    readonly removed: number;
    readonly retained: number;
    readonly savings: number;
  },
): void {
  if (!VC6A_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_closure_optimized", {
      ts: undefined,
      event: "vector_cortex_closure_optimized",
      sessionId: payload.sessionId,
      removedEdges: payload.removed,
      retainedEdges: payload.retained,
      traversalSavings: payload.savings,
    }),
  );
}

/** Report a rejected proof. Suppressed under flag-off, like the above. */
export function reportProofRejected(
  emit: HealEmit | undefined,
  payload: {
    readonly sessionId: string;
    readonly reason: string;
    readonly mode: "B" | "C";
  },
): void {
  if (!VC6A_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_closure_proof_rejected", {
      ts: undefined,
      event: "vector_cortex_closure_proof_rejected",
      sessionId: payload.sessionId,
      reason: payload.reason,
      fallbackMode: payload.mode,
    }),
  );
}
