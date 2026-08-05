/**
 * vector-cortex/heal/repair-emit.ts — VC6C event reporter seam.
 *
 * Mirrors `./restore-emit.ts`: a thin `safe()` wrapper around an optional
 * injected `emit`, and the three event names the sprint spec requires verbatim:
 *   - `vector_cortex_repair_planned`         — a gap was detected, rebuild queued.
 *   - `vector_cortex_repair_pointer_switched`— a verified generation went live.
 *   - `vector_cortex_repair_backoff`         — suppressed (rate limit) or failed.
 *
 * FLAG SEMANTICS. `detectGaps` / `planRebuild` / `rebuildGeneration` /
 * `switchPointer` are PURE arithmetic and run REGARDLESS of `MEGACOMPACT_VC6C`.
 * The flag gates ONLY this reporting + dashboard seam: with the flag off we still
 * detect gaps, still verify digests, and still refuse unverified pointer
 * switches — we just do not announce it under the VC6C event namespace. That is
 * what makes flag-off byte-identical to VC6B: the computation is never skipped,
 * only the emission.
 *
 * PAYLOAD DISCIPLINE. These events carry the SUBSYSTEM NAME, generation numbers,
 * timings, and codes — never rebuilt bytes, never a root digest of user content,
 * never a seq range's contents. The subsystem name is an operator-facing
 * identifier ("topology"), not user data. A repair event is exactly the place
 * where an unguarded `payload` field would leak a rebuilt transcript into a log.
 *
 * No console, no storage, no network (PREVENT-PI-004 / PREVENT-011). Every line
 * is a structured JSON event with `ts` + `event`.
 */

import { VC6C_ENABLED } from "../../config/vector-cortex.js";
import type { Mode, RepairEventName, RepairFailureCode } from "./repair-types.js";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type RepairEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: RepairEmit | undefined, fn: (emit: RepairEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** The event names VC6C emits, exported for the dashboard seam and tests. */
export const REPAIR_EVENT_NAMES: readonly RepairEventName[] = [
  "vector_cortex_repair_planned",
  "vector_cortex_repair_pointer_switched",
  "vector_cortex_repair_backoff",
] as const;

/** Report a planned rebuild: which subsystem, which generation, what delay. */
export function reportRepairPlanned(
  emit: RepairEmit | undefined,
  payload: {
    readonly subsystem: string;
    readonly generation: number;
    readonly backoffMs: number;
    readonly gapSize: number;
  },
): void {
  if (!VC6C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_repair_planned", {
      ts: undefined,
      event: "vector_cortex_repair_planned",
      subsystem: payload.subsystem,
      generation: payload.generation,
      backoffMs: payload.backoffMs,
      gapSize: payload.gapSize,
    }),
  );
}

/** Report the atomic commit: a verified generation became live. */
export function reportRepairPointerSwitched(
  emit: RepairEmit | undefined,
  payload: {
    readonly subsystem: string;
    readonly fromGeneration: number;
    readonly toGeneration: number;
    readonly mode: Mode;
  },
): void {
  if (!VC6C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_repair_pointer_switched", {
      ts: undefined,
      event: "vector_cortex_repair_pointer_switched",
      subsystem: payload.subsystem,
      fromGeneration: payload.fromGeneration,
      toGeneration: payload.toGeneration,
      mode: payload.mode,
    }),
  );
}

/** Report a suppressed or failed rebuild now waiting out its backoff. */
export function reportRepairBackoff(
  emit: RepairEmit | undefined,
  payload: {
    readonly subsystem: string;
    readonly code: RepairFailureCode;
    readonly backoffMs: number;
    readonly attempt: number;
  },
): void {
  if (!VC6C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_repair_backoff", {
      ts: undefined,
      event: "vector_cortex_repair_backoff",
      subsystem: payload.subsystem,
      code: payload.code,
      backoffMs: payload.backoffMs,
      attempt: payload.attempt,
    }),
  );
}
