/**
 * vc-observer.ts — VC0A mode-A eval observer wiring for MegaRuntime.
 *
 * Bridges the pure in-memory EvalObserver (src/vector-cortex/eval/observer.ts)
 * into the production runtime: every recorded compact/recall latency sample is
 * both emitted to events.log (via MegaRuntime.appendEvent) and appended to the
 * redacted evaluation.jsonl (via appendEvalRow) so the Vector Cortex dashboard
 * "Observer" histogram reads real data instead of an empty file.
 *
 * All wiring is gated on VC0A_ENABLED() (MEGACOMPACT_VC0A). Flag-off and any
 * construction/persistence error are non-fatal (PREVENT-PI-004: local FS only,
 * no network) and degrade to a null observer — byte-identical to the
 * predecessor (mode C). PREVENT-011: no `any` type.
 *
 * Follows the capture-model.ts / append-event.ts pattern: a context interface +
 * free functions + a thin delegate. No import-time side effects — merely
 * importing these functions is inert regardless of the flag.
 */

import { VC0A_ENABLED } from "../../src/config.js";
import { createEvalObserver } from "../../src/vector-cortex/eval/observer.js";
import type { EvalObserver } from "../../src/vector-cortex/eval/observer.js";
import { appendEvalRow } from "../../src/vector-cortex/eval/persist.js";

// ---------------------------------------------------------------------- types

/** The slice of `MegaRuntime` the observer bridge reads/writes. */
export interface VcObserverContext {
	appendEvent(event: string, fields: Record<string, unknown>): void;
	readonly currentStateDir: string;
}

// ------------------------------------------------------------- construction

/**
 * Build the production-wired eval observer (mode A) if the VC0A flag is on.
 * Returns null when the flag is off or on any construction error (non-fatal).
 * The returned observer is a thin, best-effort observability seam that never
 * breaks the agent loop.
 */
export function createVcObserver(self: VcObserverContext): EvalObserver | null {
	if (!VC0A_ENABLED()) return null;
	try {
		return createEvalObserver({
			emit: self.appendEvent.bind(self),
			persist: (sample) => appendEvalRow(self.currentStateDir, [sample]),
		});
	} catch {
		/* non-fatal observability — never break the agent loop */
		return null;
	}
}

// ---------------------------------------------------------------- weak cache

/**
 * Module-level observer cache keyed by the runtime object. Avoids adding a
 * `vcObserver` field to MegaRuntime (keeping runtime.ts under its soft limit
 * — no field, no constructor line, no import bloat). One observer per runtime
 * instance, lazily built on the first latency recording.
 */
const observerCache = new WeakMap<object, EvalObserver | null>();

/** Lazily create + cache the observer for the given runtime context. */
export function getVcObserver(self: VcObserverContext): EvalObserver | null {
	let obs = observerCache.get(self);
	if (obs === undefined) {
		obs = createVcObserver(self);
		observerCache.set(self, obs);
	}
	return obs;
}

// ---------------------------------------------------------------- reporting

/** Record a compact latency sample on the observer (no-op when absent). */
export function recordCompactLatency(
	self: VcObserverContext,
	elapsedMs: number,
	sessionId: string,
	epoch: number,
): void {
	const obs = getVcObserver(self);
	if (obs == null) return;
	try {
		obs.record({
			session: sessionId,
			seq: epoch,
			event: "compact",
			value: elapsedMs,
			unit: "ms",
			mode: "A",
		});
	} catch {
		/* non-fatal observability */
	}
}

/** Record a recall latency sample on the observer (no-op when absent). */
export function recordRecallLatency(
	self: VcObserverContext,
	elapsedMs: number,
	sessionId: string,
	epoch: number,
): void {
	const obs = getVcObserver(self);
	if (obs == null) return;
	try {
		obs.record({
			session: sessionId,
			seq: epoch,
			event: "recall",
			value: elapsedMs,
			unit: "ms",
			mode: "A",
		});
	} catch {
		/* non-fatal observability */
	}
}
