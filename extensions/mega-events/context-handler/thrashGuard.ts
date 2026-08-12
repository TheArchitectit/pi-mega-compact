/**
 * context-handler/thrashGuard.ts — 3WF-2 ReductionValidator + ThrashGuard.
 *
 * Production bug fixed here: compaction fired 496× freeing 0.0% of the live
 * window. Root cause — correctness was judged by the STORED `saved` metric
 * (a cumulative SQLite total that the dedup made look healthy every fire)
 * while the LIVE context window (`currentTokens`) never shrank. This module
 * judges correctness by the LIVE-WINDOW delta across consecutive `context`
 * events, and after an ineffective compaction persists a meta-backed refusal
 * so the guard will not re-fire until the window has grown meaningfully again.
 *
 * Everything is gated on the umbrella `config.threeWayFailback`
 * (MEGACOMPACT_THREE_WAY_FAILBACK, default ON). Flag OFF ⇒ every entry point
 * is an immediate no-op, so gateCheck + compactSession behave byte-identically
 * to v0.20.83.
 *
 * Non-fatal EVERYWHERE: every store read/write is best-effort, swallowed on
 * failure. Structured JSON logging only (runtime.logger.info with ts + event).
 * No console.*, no network, no mocks.
 */
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { getMetaNumber, setMetaNumber } from "../../../src/store/sqlite.js";
import type { ReductionVerdict } from "../../../src/failback/types.js";

/** Meta key holding the live-window baseline (tokens) at the ineffective fire. */
export const THRASH_BASELINE_KEY = "thrasguard.baseline_tokens";
/** Meta key holding the live-window token count below which re-firing is blocked. */
export const THRASH_BLOCKED_KEY = "thrasguard.blocked_until";

/**
 * "Meaningful reduction" floor as a FRACTION of `liveBefore`. A compaction is
 * only credited with freeing space when the live window shrank by at least this
 * fraction of its pre-compaction size.
 *
 * Rationale (invented constant, calibrated + configurable-by-design): the model
 * re-reports token counts on every context event with noise on the order of a
 * percent or two, so a sub-1% wobble is not a real reduction — crediting it
 * would suppress the guard on a genuine no-op fire (the exact bug we are
 * fixing). 2% is a defensible "real shrink" threshold: it is well above typical
 * re-estimation noise but low enough that a compaction that freed even a few
 * percent of the window is not punished. A reduction of ≤0 tokens is
 * unconditionally ineffective regardless of this floor.
 */
const MEANINGFUL_REDUCTION_PCT = 0.02;

/** Pure reduction verdict for a live-window bracketing pair. */
export const ReductionValidator = {
	/**
	 * Judge whether the LIVE window actually shrank between two consecutive
	 * context events bracketing a compaction.
	 *  - a reduction of ≤0 tokens ⇒ definitively ineffective.
	 *  - otherwise effective only when the reduction is ≥ the small positive
	 *    floor (MEANINGFUL_REDUCTION_PCT of liveBefore), so estimation noise on
	 *    the model's re-reported token count is not mistaken for a real shrink.
	 */
	validateReduction(liveBefore: number, liveAfter: number): ReductionVerdict {
		const reduction = liveBefore - liveAfter;
		const floor = Math.max(1, Math.round(MEANINGFUL_REDUCTION_PCT * liveBefore));
		const effective = Number.isFinite(reduction) && reduction > 0 && reduction >= floor;
		return { effective, liveBefore, liveAfter };
	},
};

/**
 * Arm the ThrashGuard after an ineffective compaction. Persists:
 *  - `thrasguard.baseline_tokens` = the live currentTokens at this (post-fire)
 *    context event, so re-arm is measured from the window that failed to shrink.
 *  - `thrasguard.blocked_until` = baseline + N, where N = `rearmPct ×
 *    effectiveThreshold`. Re-firing is refused until the live window grows past
 *    `blocked_until`.
 *
 * If `effectiveThreshold` is non-finite (+Infinity — the 3WF-2 invariant when
 * the model window is unknown), N cannot be computed; we MUST NOT persist
 * Infinity/NaN into meta (getMetaNumber would read it back as 0). Skip arming
 * + log instead; the next over-threshold event simply re-fires (pre-sprint
 * behavior) rather than corrupting the guard.
 *
 * 3WF-5 telemetry: `logger` is the debug-gated runtime logger (mega-compact.log,
 * silent unless config.debug) — which means the breadcrumb was invisible to the
 * dashboard Events tab, whose SSE tail reads the repo's events.log. `emit` is
 * the always-on events.log sink (MegaRuntime.appendEvent), so the armed
 * breadcrumb lands in the same stream as the other 3WF events
 * (three_way_guard_fired / three_way_floor_used / injection_confirmed /
 * injection_recovered). Both sinks are optional + best-effort; passing neither
 * keeps the pre-3WF-5 behavior.
 */
export function armThrashGuard(
	currentTokens: number,
	rearmPct: number,
	effectiveThreshold: number,
	stateDir: string,
	logger?: { info(event: string, fields?: Record<string, unknown>): void },
	emit?: (event: string, fields: Record<string, unknown>) => void,
): void {
	if (!Number.isFinite(currentTokens) || currentTokens <= 0) return;
	if (!Number.isFinite(rearmPct) || rearmPct <= 0) return;
	if (!Number.isFinite(effectiveThreshold)) {
		logger?.info("thrasguard_skip_arm", {
			reason: "nonfinite_effective_threshold",
			currentTokens,
		});
		return;
	}
	try {
		const n = Math.round(rearmPct * effectiveThreshold);
		setMetaNumber(THRASH_BASELINE_KEY, Math.round(currentTokens), stateDir);
		setMetaNumber(THRASH_BLOCKED_KEY, Math.round(currentTokens + n), stateDir);
		const fields = {
			baselineTokens: Math.round(currentTokens),
			blockedUntilTokens: Math.round(currentTokens + n),
			rearmTokens: n,
		};
		logger?.info("thrasguard_armed", fields);
		try {
			emit?.("thrasguard_armed", fields);
		} catch {
			/* non-fatal: events.log sink must never break arming */
		}
	} catch {
		/* non-fatal: best-effort meta write */
	}
}

/**
 * Consult the ThrashGuard for the current live-window token count. Returns true
 * when compaction must be refused (the window is still below the armed
 * `blocked_until`). A `blocked_until` of 0/absent ⇒ never blocked. When the
 * live tokens have grown past `blocked_until`, the guard no longer blocks
 * (caller re-fires normally). Pure read, best-effort — on any failure returns
 * false (do not refuse compaction on a store error).
 */
export function isThrashBlocked(currentTokens: number, stateDir: string): boolean {
	try {
		const blockedUntil = getMetaNumber(THRASH_BLOCKED_KEY, stateDir);
		if (blockedUntil <= 0) return false;
		return Number.isFinite(currentTokens) && currentTokens < blockedUntil;
	} catch {
		return false; // non-fatal: never refuse compaction on a read error
	}
}

/**
 * Per-runtime one-shot session state for the live-window delta correlation.
 * Like triggerGuard.ts, keyed by runtime in a WeakMap so it dies with the
 * runtime and a test can pass a thin stub. Holds the live token count observed
 * at the event that FIRED a compaction; consumed on the following context event
 * to judge whether the window actually shrank.
 */
const sessionBefore = new WeakMap<MegaRuntime, { liveBefore: number }>();

/**
 * The live-token count of the event that most recently ARMED the guard, per
 * runtime. The arming happens early in a context event (the live-delta consume
 * point), but the guard consult runs LATER IN THAT SAME EVENT — and since
 * `blocked_until = currentTokens + N`, a naive consult would always find
 * `currentTokens < blocked_until` and swallow the very event that armed it.
 * That is an off-by-one-event error: the guard's contract is to refuse
 * SUBSEQUENT re-fires, not to cancel the compaction that revealed the problem.
 * Recording the arming event's token count lets the consult skip exactly that
 * one event. Cleared once the window grows past it.
 */
const armedOnEvent = new WeakMap<MegaRuntime, number>();

/**
 * Runtime-aware ThrashGuard consult: true when a NEW compaction must be refused.
 *
 * Reads the persisted `thrasguard.blocked_until` (see `isThrashBlocked`) but
 * EXEMPTS the single event that armed the guard — otherwise, because arming sets
 * `blocked_until = currentTokens + N` earlier in the very same context event, the
 * consult would always fire and cancel the compaction that exposed the thrash.
 * The guard exists to refuse SUBSEQUENT re-fires. Once the live window grows past
 * the armed count the exemption is dropped, and normal blocking resumes until the
 * window clears `blocked_until`.
 *
 * Best-effort: any failure returns false (never refuse on a store fault).
 */
export function isThrashBlockedFor(
	runtime: MegaRuntime,
	currentTokens: number,
	stateDir: string,
): boolean {
	try {
		if (!isThrashBlocked(currentTokens, stateDir)) return false;
		const armedAt = armedOnEvent.get(runtime);
		if (armedAt !== undefined && currentTokens === armedAt) {
			// EXACTLY the event that armed the guard (same live-token reading): let it
			// through once, then block normally from the next event onward. An exact
			// match (not <=) is required so a genuinely lower or different live reading
			// on a later event is still blocked.
			armedOnEvent.delete(runtime);
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Record that a compaction fired at `liveBefore` tokens (call on the firing event). */
export function markCompactionFired(runtime: MegaRuntime, liveBefore: number): void {
	try {
		if (Number.isFinite(liveBefore) && liveBefore > 0) {
			sessionBefore.set(runtime, { liveBefore });
		}
	} catch {
		/* non-fatal */
	}
}

/**
 * Consume a pending live-window delta on a subsequent context event. If a
 * compaction fired on a prior event, compare THIS event's live tokens against
 * that pre-fire baseline; an ineffective reduction arms the guard. The pending
 * marker is consumed exactly once (cleared before any re-arm). No-op when no
 * compaction is pending, when the umbrella flag is OFF, or on any error.
 */
export function evaluatePendingReduction(
	runtime: MegaRuntime,
	currentTokens: number,
	config: MegaConfig,
): void {
	if (!config.threeWayFailback) return;
	const pending = sessionBefore.get(runtime);
	if (pending == null) return;
	try {
		sessionBefore.delete(runtime); // consume once, regardless of verdict
		const verdict = ReductionValidator.validateReduction(pending.liveBefore, currentTokens);
		if (!verdict.effective) {
			// Remember which event armed us so the consult later in THIS SAME event
			// does not swallow it (see armedOnEvent).
			armedOnEvent.set(runtime, currentTokens);
			// 3WF-5: also emit the breadcrumb on the always-on events.log sink so
			// the dashboard Events tab sees it (runtime.logger is debug-gated).
			// Optional-chained: a thin runtime stub without appendEvent stays valid.
			const emit =
				typeof runtime.appendEvent === "function"
					? runtime.appendEvent.bind(runtime)
					: undefined;
			armThrashGuard(
				currentTokens,
				config.thrashRearmPct,
				runtime.effectiveThreshold,
				runtime.currentStateDir,
				runtime.logger,
				emit,
			);
		}
	} catch {
		/* non-fatal */
	}
}
