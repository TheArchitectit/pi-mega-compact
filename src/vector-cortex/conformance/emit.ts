/**
 * vector-cortex/conformance/emit.ts — VC1C observability seam.
 *
 * Emits the three VC1C structured events, all gated on `MEGACOMPACT_VC1C`
 * (mode C parity: flag OFF => zero emissions). Every event is a JSON line with
 * `ts` + `event` (ENGINEERING_PRACTICES §8); the emitters below capture the
 * event name + fields and are never fatal on consumer failure (non-fatal
 * observability, never breaks the agent loop).
 *
 *   vector_cortex_minhash_v2_backfilled     — M4 backfill wrote v2 rows
 *   vector_cortex_conformance_case_checked  — a v2 conformance case dispatched
 *   vector_cortex_downgrade_copy_written    — a downgrade legacy copy written
 *
 * No network, no side effects beyond the supplied emit callback
 * (PREVENT-PI-004 / PREVENT-011).
 */

import { VC1C_ENABLED } from "../../config/vector-cortex.js";

export type ConformanceEmit = (event: string, fields: Record<string, unknown>) => void;

/** The three-event reporter surface consumed by the runtime seams. */
export interface ConformanceReporter {
  readonly backfilled: (fields: Record<string, unknown>) => void;
  readonly caseChecked: (fields: Record<string, unknown>) => void;
  readonly downgradeWritten: (fields: Record<string, unknown>) => void;
}

/** A flag-gated no-op reporter (zero emissions, default when none injected). */
export const NOOP_CONFORMANCE_REPORTER: ConformanceReporter = {
  backfilled: () => {},
  caseChecked: () => {},
  downgradeWritten: () => {},
};

/**
 * Flag-gated emit: no-op when VC1C is off or no emitter is supplied. The
 * returned reporter is itself flag-gated (`VC1C_ENABLED`), so wiring it into a
 * runtime seam yields zero emissions when `MEGACOMPACT_VC1C=0` (byte-identical
 * to the predecessor).
 */
export function createConformanceReporter(emit?: ConformanceEmit): ConformanceReporter {
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC1C_ENABLED()) return;
    try {
      emit?.(event, { ...fields, ts: new Date().toISOString() });
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    backfilled: (fields) => fire("vector_cortex_minhash_v2_backfilled", fields),
    caseChecked: (fields) => fire("vector_cortex_conformance_case_checked", fields),
    downgradeWritten: (fields) => fire("vector_cortex_downgrade_copy_written", fields),
  };
}
