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
	readonly currentStateDir: string;
}

// ------------------------------------------------------------- construction

/**
 * Build the production-wired eval observer (mode A) if the VC0A flag is on.
 * Returns null when the flag is off or on any construction error (non-fatal).
 * The returned observer is a thin, best-effort observability seam that never
 * breaks the agent loop.
 */
export function createVcObserver(self: {
	appendEvent(event: string, fields: Record<string, unknown>): void;
	currentStateDir: string;
}): EvalObserver | null {
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

// ---------------------------------------------------------------- reporting

/** Record a compact latency sample on the observer (no-op when absent). */
export function recordCompactLatency(
	self: { vcObserver: EvalObserver | null },
	elapsedMs: number,
	sessionId: string,
	epoch: number,
): void {
	if (self.vcObserver == null) return;
	try {
		self.vcObserver.record({
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
	self: { vcObserver: EvalObserver | null },
	elapsedMs: number,
	sessionId: string,
	epoch: number,
): void {
	if (self.vcObserver == null) return;
	try {
		self.vcObserver.record({
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
