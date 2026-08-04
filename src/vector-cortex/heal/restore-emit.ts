/**
 * vector-cortex/heal/restore-emit.ts — VC6B event reporter seam.
 *
 * Mirrors `./emit.ts`: a thin `safe()` wrapper around an optional injected
 * `emit` (unit tests pass `undefined` and stay pure), and the two event names the
 * sprint spec requires verbatim:
 *   - `vector_cortex_source_restored`         — a restore batch completed.
 *   - `vector_cortex_restore_digest_rejected` — a source failed its digest check.
 *
 * FLAG SEMANTICS. `restoreSources` / `verifyRestored` are PURE arithmetic and run
 * REGARDLESS of `MEGACOMPACT_VC6B`. The flag gates ONLY this reporting +
 * dashboard seam: with the flag off we still restore and still verify, we just do
 * not announce it under the VC6B event namespace. That is what makes flag-off
 * byte-identical to VC6A — the computation is never skipped, only the emission.
 *
 * PAYLOAD DISCIPLINE. These events carry COUNTS and MODES only — never restored
 * bytes, never node text, never a digest of user content. The exact ledger is not
 * diagnostic data (SECURITY_PRIVACY), and a restoration event is exactly the
 * place where an unguarded `payload` field would leak the entire transcript into
 * a log file.
 *
 * No console, no storage, no network (PREVENT-PI-004 / PREVENT-011). Every line
 * is a structured JSON event with `ts` + `event`.
 */

import { VC6B_ENABLED } from "../../config/vector-cortex.js";
import type { RestoreEventName, RestoreFailureCode } from "./restore-types.js";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type RestoreEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: RestoreEmit | undefined, fn: (emit: RestoreEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** The event names VC6B emits, exported for the dashboard seam and tests. */
export const RESTORE_EVENT_NAMES: readonly RestoreEventName[] = [
  "vector_cortex_source_restored",
  "vector_cortex_restore_digest_rejected",
] as const;

/**
 * Report a completed restoration. Counts and mode only — enough to see whether
 * the shard index is serving reads (mode A) or every span is falling through to
 * a ledger scan (mode B), without disclosing what was restored.
 */
export function reportSourceRestored(
  emit: RestoreEmit | undefined,
  payload: {
    readonly sessionId: string;
    readonly restoredCount: number;
    readonly missingCount: number;
    readonly mode: "A" | "B" | "C";
  },
): void {
  if (!VC6B_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_source_restored", {
      ts: undefined,
      event: "vector_cortex_source_restored",
      sessionId: payload.sessionId,
      restoredCount: payload.restoredCount,
      missingCount: payload.missingCount,
      mode: payload.mode,
    }),
  );
}

/** Report a rejected source (digest/limit/range). Suppressed under flag-off. */
export function reportRestoreDigestRejected(
  emit: RestoreEmit | undefined,
  payload: {
    readonly sessionId: string;
    readonly code: RestoreFailureCode;
    readonly mode: "A" | "B" | "C";
  },
): void {
  if (!VC6B_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_restore_digest_rejected", {
      ts: undefined,
      event: "vector_cortex_restore_digest_rejected",
      sessionId: payload.sessionId,
      code: payload.code,
      mode: payload.mode,
    }),
  );
}
