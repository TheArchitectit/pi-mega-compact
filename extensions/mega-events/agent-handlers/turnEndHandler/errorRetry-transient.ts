/**
 * turnEndHandler/errorRetry-transient.ts — transient/permanent retry branch.
 *
 * Extracted from errorRetry.ts (delegate-shell split) to keep every source
 * file under the extensions soft limit. Contains the S38.6 circuit breaker,
 * R10 provider-outage advisory, per-burst max, R2 session cap, R1 in-flight
 * dedup + gating backoff, and the actual retry nudge send.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../../mega-runtime.js";
import type { MegaConfig } from "../../../mega-config.js";
import { errorRetryBackoffMs } from "../../error-classifier.js";
import { safeSendInvisibleMessage } from "../../send-safe.js";
import { maybeSendProviderOutageAdvisory } from "../../outage-advisor.js";
import type { TurnEndEvent } from "./event.js";

/** Context needed from the caller's scope for the transient/permanent branch. */
export interface TransientRetryContext {
	readonly effectiveCategory: string;
	readonly detail: { signal?: string };
	readonly errSig: string | undefined;
}

/** Handle the transient or permanent error-retry path. Non-fatal. */
export async function transientRetry(
	event: TurnEndEvent,
	_ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
	tc: TransientRetryContext,
): Promise<void> {
	const { effectiveCategory, detail, errSig } = tc;
	// S38.7: hard-stop switch — bypass ALL retry logic when set.
	if (config.errorRetryHardStop) {
		runtime.rt.errorRetryCount = 0;
		runtime.dashboard.event("error_retry_disabled", {
			category: effectiveCategory,
			turnIndex: event.turnIndex,
			reason: "hard-stop",
		});
		return; // early exit — no retry
	}
	// S38.6: circuit-breaker — stop retrying after too many consecutive errors.
	runtime.rt.consecutiveErrors++;
	// R10: send calm "provider outage" advisory once per episode.
	await maybeSendProviderOutageAdvisory(
		effectiveCategory, runtime, pi, config,
		{ signal: detail.signal, rawText: (errSig || '').slice(0, 500) },
	);
	if (runtime.rt.consecutiveErrors > config.maxConsecutiveErrors) {
		runtime.dashboard.event("error_retry_circuit_open", {
			consecutive: runtime.rt.consecutiveErrors,
			max: config.maxConsecutiveErrors,
			turnIndex: event.turnIndex,
		});
		runtime.logger.warn("error-retry-circuit-open", {
			sessionId: runtime.rt.sessionId,
			consecutive: runtime.rt.consecutiveErrors,
			max: config.maxConsecutiveErrors,
		});
		return; // early exit — circuit breaker tripped
	}
	const max =
		effectiveCategory === "transient"
			? config.autoRetryTransientMax
			: config.autoRetryPermanentMax;
	// max === 0 disables the category entirely (revert to S28-only).
	if (max <= 0) {
		runtime.rt.errorRetryCount = 0;
		return;
	}
	runtime.rt.errorRetryCount++;
	if (runtime.rt.errorRetryCount > max) {
		// Exhausted — surface the error, reset for the next burst.
		runtime.dashboard.event("error_retry_exhausted", {
			category: effectiveCategory,
			count: runtime.rt.errorRetryCount,
			max,
			turnIndex: event.turnIndex,
		});
		runtime.logger.info("error-retry-exhausted", {
			sessionId: runtime.rt.sessionId,
			category: effectiveCategory,
			count: runtime.rt.errorRetryCount,
			max,
		});
		runtime.rt.errorRetryCount = 0;
		return;
	}
	// R2: session-global cap — total S38 nudges per session across ALL bursts.
	// Independent of the per-burst max and the circuit breaker. Hitting it is
	// terminal for the session: log + dashboard event, stop nudging. `0` disables.
	if (
		config.errorRetrySessionMax > 0 &&
		runtime.rt.errorRetrySessionCount >= config.errorRetrySessionMax
	) {
		runtime.dashboard.event("error_retry_session_exhausted", {
			count: runtime.rt.errorRetrySessionCount,
			max: config.errorRetrySessionMax,
			category: effectiveCategory,
			turnIndex: event.turnIndex,
		});
		runtime.logger.warn("error-retry-session-exhausted", {
			sessionId: runtime.rt.sessionId,
			count: runtime.rt.errorRetrySessionCount,
			max: config.errorRetrySessionMax,
			category: effectiveCategory,
		});
		runtime.rt.errorRetryCount = 0;
		return; // terminal for the session — no nudge
	}
	// R1: in-flight nudge dedup — a nudge queued via deliverAs:'followUp' must
	// not be re-sent until consumed by an actual new agent turn (turn_start
	// resets retryNudgePending). Without this, a fast-erroring provider + a
	// per-turn nudge → N nudges queue up and pi dispatches N retry turns, each
	// re-submitting the same failing prompt (the 2026-07-28 incident).
	if (runtime.rt.retryNudgePending) {
		runtime.dashboard.event("error_retry_dedup_skip", {
			category: effectiveCategory,
			count: runtime.rt.errorRetryCount,
			max,
			turnIndex: event.turnIndex,
		});
		return; // pending nudge not yet consumed — skip
	}
	// R1: gating backoff — errorRetryUntil is GATING. A nudge cannot fire before
	// the previous backoff elapses. Paces retries (5s/10s/20s/30s default).
	const now = Date.now();
	if (now < runtime.rt.errorRetryUntil) {
		runtime.dashboard.event("error_retry_backoff_skip", {
			category: effectiveCategory,
			count: runtime.rt.errorRetryCount,
			max,
			turnIndex: event.turnIndex,
		});
		return; // backoff not elapsed — skip
	}
	// Fire the retry nudge. Set pending (R1 dedup) + backoff (R1 pacing) +
	// session count (R2 cap) BEFORE the await so a re-entrant turn_end during
	// the send can't double-fire.
	runtime.rt.retryNudgePending = true;
	runtime.rt.lastErrorRetryAt = now;
	runtime.rt.errorRetryUntil =
		now +
		errorRetryBackoffMs(
			runtime.rt.errorRetryCount,
			config.errorRetryBackoffMs,
		);
	runtime.rt.errorRetrySessionCount++;
	runtime.dashboard.event("error_retry", {
		category: effectiveCategory,
		count: runtime.rt.errorRetryCount,
		max,
		turnIndex: event.turnIndex,
	});
	runtime.logger.info("error-retry", {
		sessionId: runtime.rt.sessionId,
		category: effectiveCategory,
		count: runtime.rt.errorRetryCount,
		max,
	});
	// PREVENT-PI-003: user-role only (queued + catch-guarded).
	// Invisible: display:false so the retry trigger fires without
	// rendering "Follow-up:" spam in the conversation UI.
	await safeSendInvisibleMessage(
		pi,
		"[mega-compact] the last turn ended with an error; please retry.",
	);
}
