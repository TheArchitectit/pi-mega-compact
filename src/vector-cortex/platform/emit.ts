/**
 * platform/emit.ts — VC8C engine parity/selection reporter seam (FLAG-GATED).
 *
 * Mirrors the VC8B policy-emit pattern: a thin `safe()` wrapper around an
 * optional injected `emit`, and the two event names the sprint spec requires:
 *   - `vector_cortex_engine_parity_checked`   — a parity report was resolved.
 *   - `vector_cortex_engine_selection_demoted` — the triad dropped from A.
 *
 * FLAG SEMANTICS. The engine selector and cross-conformance runner STILL RUN
 * regardless of `MEGACOMPACT_VC8C`. The flag gates ONLY this reporting +
 * dashboard seam: flag-off is byte-identical to the predecessor (VC8B).
 *
 * PAYLOAD DISCIPLINE. These events carry only ids, the finite mode, the machine
 * code, and counts — never artifact bytes, output bytes, or free-text.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any` type.
 */

import { VC8C_ENABLED } from "../../config/vector-cortex.js";

/** The two structured events the VC8C reporter emits. */
export type PlatformEventName =
  | "vector_cortex_engine_parity_checked"
  | "vector_cortex_engine_selection_demoted";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type PlatformEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: PlatformEmit | undefined, fn: (emit: PlatformEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** Report a resolved engine parity check. Gated by the flag. */
export function reportEngineParityChecked(
  emit: PlatformEmit | undefined,
  parity: {
    readonly reportId: string;
    readonly fixtureCount: number;
    readonly passed: number;
    readonly failed: number;
  },
): void {
  if (!VC8C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_engine_parity_checked", {
      ts: undefined,
      event: "vector_cortex_engine_parity_checked",
      reportId: parity.reportId,
      fixtureCount: parity.fixtureCount,
      passed: parity.passed,
      failed: parity.failed,
    }),
  );
}

/** Report an engine selection demotion away from mode A. Gated by the flag. */
export function reportEngineSelectionDemoted(
  emit: PlatformEmit | undefined,
  demotion: { readonly from: "A"; readonly to: "B" | "C"; readonly code: string },
): void {
  if (!VC8C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_engine_selection_demoted", {
      ts: undefined,
      event: "vector_cortex_engine_selection_demoted",
      from: demotion.from,
      to: demotion.to,
      code: demotion.code,
    }),
  );
}
