/**
 * internal-errors.ts — Sprint H (Finding 3 / Option A) instrumentation.
 *
 * Free-function + context-interface sibling of `runtime.ts` (delegate-shell
 * pattern). Holds the body of `recordInternalError(category)` so the
 * `MegaRuntime` class stays a field-declarations + 1-line-delegate shell.
 *
 * Pushes a store/service-write failure category into the `recentInternalErrors`
 * ring (capped at RING_MAX, shift when over). Called AT each failure emit site
 * (see the §2.3a audit in docs/specs/c2-resume-and-health-fixes.md) — never by
 * a central events.log filter. Feeds the distinct `storeErrorRate` 6th health
 * axis (committed separately in Sprint H axis work).
 */
import type { MegaRuntime } from "./runtime.js";

/**
 * RING_MAX — the cap for the rolling health ring buffers
 * (`recentTurnEmbeddings`, `recentErrorCategories`, `recentInternalErrors`).
 * Defined here (with the ring writer) and re-exported from runtime.ts so the
 * ring + its writer live together; health-handler.ts imports it.
 */
export const RING_MAX = 5;

/** Push a category into the internal-error ring. Mirrors `recentErrorCategories`. */
export function recordInternalErrorImpl(rt: MegaRuntime, category: string): void {
	rt.recentInternalErrors.push(category);
	if (rt.recentInternalErrors.length > RING_MAX) {
		rt.recentInternalErrors.shift();
	}
}
