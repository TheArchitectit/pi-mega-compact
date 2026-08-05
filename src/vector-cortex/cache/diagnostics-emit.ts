/**
 * cache/diagnostics-emit.ts — VC7C reporter seam (FLAG-GATED).
 *
 * Mirrors `./economics-emit.ts`: a thin `safe()` wrapper around an optional
 * injected `emit`, and the two event names the sprint spec requires verbatim:
 *   - `vector_cortex_cache_miss_classified` — a miss was classified.
 *   - `vector_cortex_cache_serve_blocked` — a cache serve was blocked by a
 *     breaker condition before it could answer from a stale/invalid identity.
 *
 * FLAG SEMANTICS. `classifyMiss` (`./diagnostics.ts`) is PURE and runs REGARDLESS
 * of `MEGACOMPACT_VC7C`. The flag gates ONLY this reporting + dashboard seam:
 * with the flag off the classifier still returns the SAME class, the breaker
 * still blocks the SAME serve — we just do not announce them under the VC7C
 * event namespace, and the dashboard reports `enabled:false` + mode C. That is
 * what makes flag-off byte-identical to the predecessor (VC7B): the arithmetic
 * and the correctness decision are never skipped, only the emission. (NOTE the
 * asymmetry vs VC7B: VC7B gated pure telemetry; here the blocked-serve DECISION
 * is a correctness behavior and is never flag-gated — only its announcement is.)
 *
 * PAYLOAD DISCIPLINE. These events carry the `missClass` and the payload-free
 * `evidence` booleans/counts (see `./diagnostics-types.ts`) — never a session
 * id, never a covered range, never a request or covered digest. The classifier
 * is payload-free by construction, so there is no slot to leak into
 * (SECURITY_PRIVACY — the exact ledger is not diagnostic data).
 *
 * No console, no storage, no network (PREVENT-PI-004 / PREVENT-011). Every line
 * is a structured JSON event with `ts` + `event`.
 */

import { VC7C_ENABLED } from "../../config/vector-cortex.js";
import type { CacheDiagnosticV1, MissClass } from "./diagnostics-types.js";

/** The two structured events the VC7C reporter emits. */
export type CacheDiagnosticEventName =
  | "vector_cortex_cache_miss_classified"
  | "vector_cortex_cache_serve_blocked";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type CacheDiagnosticEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(
  emit: CacheDiagnosticEmit | undefined,
  fn: (emit: CacheDiagnosticEmit) => void,
): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** Report a classified miss. Gated only by the reporter/dashboard flag. */
export function reportCacheMissClassified(
  emit: CacheDiagnosticEmit | undefined,
  diagnostic: CacheDiagnosticV1,
): void {
  if (!VC7C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_cache_miss_classified", {
      ts: undefined,
      event: "vector_cortex_cache_miss_classified",
      schema: diagnostic.schema,
      missClass: diagnostic.missClass,
      evidence: diagnostic.evidence,
    }),
  );
}

/** Report a cache serve that was blocked before answering. Gated by the flag. */
export function reportCacheServeBlocked(
  emit: CacheDiagnosticEmit | undefined,
  blocked: {
    readonly missClass: MissClass;
    readonly triadState: string;
    readonly reason: string;
  },
): void {
  if (!VC7C_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_cache_serve_blocked", {
      ts: undefined,
      event: "vector_cortex_cache_serve_blocked",
      missClass: blocked.missClass,
      triadState: blocked.triadState,
      reason: blocked.reason,
    }),
  );
}
