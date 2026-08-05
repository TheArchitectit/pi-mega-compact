/**
 * vector-cortex/cache/crystal-emit.ts — VC7A event reporter seam.
 *
 * Mirrors `../heal/restore-emit.ts`: a thin `safe()` wrapper around an optional
 * injected `emit` (unit tests pass `undefined` and stay pure), and the two event
 * names the sprint spec requires verbatim:
 *   - `vector_cortex_crystal_written`   — a crystal was frozen and published.
 *   - `vector_cortex_crystal_collision` — a same-key, different-bytes write was
 *                                         refused.
 *
 * FLAG SEMANTICS. `encodeCrystalKey` and every `CrystalStore` operation are PURE
 * and run REGARDLESS of `MEGACOMPACT_VC7A`. The flag gates ONLY this reporting +
 * dashboard seam: with the flag off we still key crystals identically, still
 * write once, and still refuse collisions — we just do not announce it under the
 * VC7A event namespace, and the dashboard reports `enabled:false` + mode C. That
 * is what makes flag-off byte-identical to VC6C: the arithmetic is never skipped,
 * only the emission.
 *
 * PAYLOAD DISCIPLINE. These events carry the KEY DIGEST, byte COUNTS, and the
 * failure code — never the frozen bytes, never covered source text, never the
 * span digests of user content. A crystal is a rendered prompt: an unguarded
 * `payload` field here would dump the entire framed conversation into a log file
 * (SECURITY_PRIVACY — the exact ledger is not diagnostic data).
 *
 * No console, no storage, no network (PREVENT-PI-004 / PREVENT-011). Every line
 * is a structured JSON event with `ts` + `event`.
 */

import { VC7A_ENABLED } from "../../config/vector-cortex.js";
import type { CrystalEventName, CrystalFailureCode, CrystalMode } from "./types.js";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type CrystalEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: CrystalEmit | undefined, fn: (emit: CrystalEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** The event names VC7A emits, exported for the dashboard seam and tests. */
export const CRYSTAL_EVENT_NAMES: readonly CrystalEventName[] = [
  "vector_cortex_crystal_written",
  "vector_cortex_crystal_collision",
] as const;

/**
 * Report a published crystal. Key digest + byte count + mode only — enough to
 * see whether the cache is filling and being hit, without disclosing what was
 * frozen.
 */
export function reportCrystalWritten(
  emit: CrystalEmit | undefined,
  payload: {
    readonly keyDigest: string;
    readonly byteCount: number;
    readonly mode: CrystalMode;
  },
): void {
  if (!VC7A_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_crystal_written", {
      ts: undefined,
      event: "vector_cortex_crystal_written",
      keyDigest: payload.keyDigest,
      byteCount: payload.byteCount,
      mode: payload.mode,
    }),
  );
}

/**
 * Report a refused write. A collision means two renders of the SAME identity
 * disagreed — a determinism bug — so the code is surfaced rather than swallowed.
 * Suppressed under flag-off.
 */
export function reportCrystalCollision(
  emit: CrystalEmit | undefined,
  payload: {
    readonly keyDigest: string;
    readonly code: CrystalFailureCode;
    readonly mode: CrystalMode;
  },
): void {
  if (!VC7A_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_crystal_collision", {
      ts: undefined,
      event: "vector_cortex_crystal_collision",
      keyDigest: payload.keyDigest,
      code: payload.code,
      mode: payload.mode,
    }),
  );
}
