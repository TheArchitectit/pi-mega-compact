/**
 * turnEndHandler/errorRetry.ts — S38/R1-R11 error-retry safety net.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Catches ALL error types (provider failure,
 * network timeout, 5xx, 429, auth, compaction-noop, poisoned-context) that
 * surface at turn_end. Non-fatal: wrapped in try/catch so a classifier/retry
 * failure never breaks the agent loop. PREVENT-PI-003: retry nudge fires via
 * pi.sendUserMessage (user-role). R1-R4 (retry redesign) bound the loop:
 * in-flight dedup, gating backoff, session-global cap, poisoned-context
 * detection.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../../mega-runtime.js";
import { piCompactWouldNoop } from "../../../mega-pipeline.js";
import type { MegaConfig } from "../../../mega-config.js";
import {
	classifyError,
	classifyErrorDetailed,
	errorRetryBackoffMs,
	extractErrorSignature,
	isKnownRetryableTransient,
} from "../../error-classifier.js";
import { safeSendUserMessage } from "../../send-safe.js";
import { maybeSendProviderOutageAdvisory } from "../../outage-advisor.js";
import type { TurnEndEvent } from "./event.js";

/** S38: broader error-retry safety net. Non-fatal end-to-end. */
export async function errorRetry(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): Promise<void> {
	// S38: broader error-retry safety net. S28 only catches stopReason==='length';
	// this catches ALL other error types (provider failure, network timeout, 5xx,
	// 429, auth, compaction-noop, poisoned-context) that surface at turn_end.
	// Non-fatal: wrapped in try/catch so a classifier/retry failure never breaks
	// the agent loop. PREVENT-PI-003: retry nudge fires via pi.sendUserMessage
	// (user-role). R1-R4 (retry redesign) bound the loop: in-flight dedup,
	// gating backoff, session-global cap, poisoned-context detection.
	try {
		// (1) S28 owns length — skip the classifier entirely for it.
		const sr = (event.message as { stopReason?: string } | undefined)
			?.stopReason;
		if (sr === "length") {
			// S28 handles; nothing for S38 to do here.
		} else {
			const category = classifyError(event.message);
			const detail = classifyErrorDetailed(event.message);
			runtime.lastErrorCategory = category;
			// R3: stateful poisoned-context signal — repeated identical error text
			// across consecutive turns. The classifier is stateless, so this
			// upgrade happens here. A 'transient' (or 'poisoned-context') turn
			// whose normalized error signature matches the previous one bumps
			// errorTextRepeatCount; once it crosses the threshold, the category
			// is upgraded to 'poisoned-context' (the request is deterministic) —
			// R7: unless the signature carries a known-retryable network/
			// throughput marker (guard below). Conservative: only upgrade, never
			// downgrade, and only for transient (a 'permanent' auth error
			// repeating is still permanent).
			let effectiveCategory = category;
			const errSig = extractErrorSignature(event.message);
			if (category === "transient" || category === "poisoned-context") {
				if (errSig) {
					if (runtime.rt.lastErrorText === errSig) {
						runtime.rt.errorTextRepeatCount++;
					} else {
						runtime.rt.lastErrorText = errSig;
						runtime.rt.errorTextRepeatCount = 1;
					}
					if (
						runtime.rt.errorTextRepeatCount >=
							config.poisonedContextRepeatThreshold &&
						category === "transient"
					) {
						// R3/R7: upgrade only when the repeating error carries NO
						// known-retryable marker. Network/throughput failures (timeout,
						// ECONNRESET, 5xx, 429, connection lost, …) that repeat are
						// still retryable — the API is just flaky, and /clear cannot fix
						// them (2026-07-30 false-alarm incident). Only upgrade
						// transient → poisoned-context for errors that repeat identically
						// with no known-retryable cause, like the 2026-07-28 incident
						// where the provider returned "Request failed — please retry."
						// deterministically. The marker set is shared with classifyError
						// (error-classifier.ts) so the two never drift.
						if (!isKnownRetryableTransient(errSig)) {
							effectiveCategory = "poisoned-context";
						} else {
							runtime.logger.info("repeat-upgrade-declined", {
								sessionId: runtime.rt.sessionId,
								signature: (errSig || '').slice(0, 500),
								repeatCount: runtime.rt.errorTextRepeatCount,
							});
						}
					}
				}
			} else {
				// Non-transient (success, cancelled, compaction-noop, context-overflow,
				// permanent): a fresh non-identical signal clears the repeat tracker.
				runtime.rt.lastErrorText = undefined;
				runtime.rt.errorTextRepeatCount = 0;
			}
			if (effectiveCategory === null) {
				// (3) success / normal flow / unknown-but-non-retryable — reset.
				runtime.rt.errorRetryCount = 0;
				runtime.rt.consecutiveErrors = 0; // S38.6: circuit-breaker reset on success
				// R4: a successful assistant turn consumes any queued nudge.
				runtime.rt.retryNudgePending = false;
				// R10: reset outage advisory so a recovered-then-flapping
				// provider re-advises once per episode.
				runtime.rt.providerOutageAdvised = false;
			} else if (effectiveCategory === "compaction-noop") {
				// (4) pi race / manual compact catch — NOT retryable. The compaction
				// already succeeded via pi's native path; retrying would race again
				// (FAIL-2026071701). Log a diagnostic, reset the counter, and surface
				// the original error WITHOUT firing a retry nudge.
				runtime.rt.errorRetryCount = 0;
				runtime.rt.consecutiveErrors = 0; // S38.6: circuit-breaker reset
				runtime.rt.retryNudgePending = false; // R4: terminal for this burst
				runtime.dashboard.event("compaction_noop_diagnostic", {
					turnIndex: event.turnIndex,
					sessionId: runtime.rt.sessionId,
				});
				runtime.logger.info("compaction-noop-diagnostic", {
					sessionId: runtime.rt.sessionId,
					turnIndex: event.turnIndex,
				});
			} else if (effectiveCategory === "cancelled") {
				// (4c) User ESC / Ctrl-C — stopReason === 'aborted'. NOT retryable:
				// nudging would restart a task the user explicitly stopped.
				// Reset both counters (a cancel is not an error for circuit-breaker
				// purposes). Emit a diagnostic so the dashboard shows it.
				runtime.rt.errorRetryCount = 0;
				runtime.rt.consecutiveErrors = 0;
				runtime.rt.retryNudgePending = false; // R4: terminal for this burst
				runtime.dashboard.event("error_retry_cancelled", {
					turnIndex: event.turnIndex,
					sessionId: runtime.rt.sessionId,
				});
				runtime.logger.info("error-retry-cancelled", {
					sessionId: runtime.rt.sessionId,
					turnIndex: event.turnIndex,
				});
			} else if (effectiveCategory === "context-overflow") {
				// (4b) context-window overflow 400 ("too long... even after compaction").
				// NOT a blind retry: re-submitting the same oversized prompt would just
				// re-400 and busy-loop. Reset the counters (this turn is terminal, not
				// retryable in the S38 sense) and force ONE best-effort re-compact with
				// the debounce bypassed + the same race-guard (lastNativeCompactAt
				// cooldown + deferred setTimeout re-check) as the agent_end durable
				// trim. Resume after that forced compact is handled by the existing
				// nudgeResume() inside session_before_compact (it fires after
				// driveNativeCompaction supplies the compaction) — do NOT add a
				// separate nudge here.
				runtime.rt.errorRetryCount = 0;
				runtime.rt.consecutiveErrors = 0;
				runtime.rt.retryNudgePending = false; // R4: terminal for this burst
				runtime.dashboard.event("context_overflow", {
					turnIndex: event.turnIndex,
					sessionId: runtime.rt.sessionId,
				});
				runtime.logger.warn("context-overflow", {
					sessionId: runtime.rt.sessionId,
					turnIndex: event.turnIndex,
				});
				if (config.auto) {
					const now2 = Date.now();
					const cooldownMs2 = config.raceGuardStrict ? 30_000 : 10_000;
					const sinceCompact2 = now2 - (runtime.rt.lastNativeCompactAt ?? 0);
					if (sinceCompact2 >= cooldownMs2 && !piCompactWouldNoop(ctx)) {
						runtime.debounceUntil = now2 + 0;
						const stamp2 = runtime.rt.lastNativeCompactAt;
						const liveSid2 = runtime.rt.sessionId;
						setTimeout(() => {
							try {
								if (runtime.rt.sessionId !== liveSid2) return; // session reset
								const since3 =
									Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
								if (
									runtime.rt.lastNativeCompactAt !== stamp2 &&
									since3 < cooldownMs2
								)
									return;
								if (piCompactWouldNoop(ctx)) return;
								ctx.compact({ customInstructions: undefined }); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; deferred + re-validated. Forced re-compact after a context-overflow 400.
							} catch {
								/* non-fatal */
							}
						}, 500);
					}
				}
			} else if (effectiveCategory === "poisoned-context") {
				// R3: poisoned context — a DETERMINISTIC request-rejection that
				// retrying cannot fix (0-token 'error', generic "request failed",
				// 400 non-overflow, or repeated identical error text). NO blind
				// retry nudge — re-submitting the same poisoned prompt re-triggers
				// the same rejection (the 2026-07-28 incident: ~60-message spam).
				// Instead: (a) dashboard event + warn log naming the suspected
				// poison; (b) ONE user-role advise message (/clear or /new) per
				// session, throttled; (c) if config.auto, ONE guarded compact per
				// error signature (same race-guarded deferred path as context-
				// overflow) — only if not already attempted for this signature.
				runtime.rt.errorRetryCount = 0; // poisoned is terminal for this burst
				runtime.rt.consecutiveErrors++; // still counts toward the circuit breaker
				runtime.rt.poisonedCount++; // R7: dashboard counter
				const sig = errSig || "unknown";
				// (a) dashboard + log — R11: include signal + rawText for forensics
				runtime.dashboard.event("poisoned_context", {
					signature: sig,
					repeatCount: runtime.rt.errorTextRepeatCount,
					turnIndex: event.turnIndex,
					sessionId: runtime.rt.sessionId,
					signal: detail.signal,
					rawText: (errSig || '').slice(0, 500),
					...(detail.httpStatus !== undefined ? { httpStatus: detail.httpStatus } : {}),
				});
				runtime.logger.warn("poisoned-context", {
					sessionId: runtime.rt.sessionId,
					turnIndex: event.turnIndex,
					signature: sig,
					repeatCount: runtime.rt.errorTextRepeatCount,
					signal: detail.signal,
					rawText: (errSig || '').slice(0, 500),
					...(detail.httpStatus !== undefined ? { httpStatus: detail.httpStatus } : {}),
				});
				// (b) throttle flag: set unconditionally so the advise fires at
				// most once per session regardless of channel.
				runtime.rt.poisonedAdviseSent = true;
				// Legacy flag-OFF path: user-role advise message.
				// Default ON (advisoryChannel=true): dashboard-only, no user message.
				if (!config.advisoryChannel) {
					// PREVENT-PI-003: user-role sendUserMessage only.
					await safeSendUserMessage(
						pi,
						"[mega-compact] this session's context may be poisoned (the provider is rejecting every request). Run /clear or /new to start a fresh context.",
					);
				}
				// (c) one guarded compact per error signature (attempt to remove
				// the poisoned region). Race-guarded + deferred, mirroring the
				// context-overflow path. Only if not already attempted for this
				// signature (poisonedCompactSignatures).
				if (config.auto && !runtime.rt.poisonedCompactSignatures.has(sig)) {
					runtime.rt.poisonedCompactSignatures.add(sig);
					const nowP = Date.now();
					const cooldownMsP = config.raceGuardStrict ? 30_000 : 10_000;
					const sinceCompactP = nowP - (runtime.rt.lastNativeCompactAt ?? 0);
					if (sinceCompactP >= cooldownMsP && !piCompactWouldNoop(ctx)) {
						runtime.debounceUntil = nowP + 0;
						const stampP = runtime.rt.lastNativeCompactAt;
						const liveSidP = runtime.rt.sessionId;
						setTimeout(() => {
							try {
								if (runtime.rt.sessionId !== liveSidP) return; // session reset
								const sinceP =
									Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
								if (
									runtime.rt.lastNativeCompactAt !== stampP &&
									sinceP < cooldownMsP
								)
									return;
								if (piCompactWouldNoop(ctx)) return;
								ctx.compact({ customInstructions: undefined }); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; deferred + re-validated. One guarded compact after a poisoned-context detection.
							} catch {
								/* non-fatal */
							}
						}, 500);
					}
				}
			} else {
				// (5) transient or permanent — retry with exponential backoff.
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
				} else {
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
					} else {
						// R2: session-global cap — total S38 nudges per session across
						// ALL bursts. Independent of the per-burst max and the circuit
						// breaker. Hitting it is terminal for the session: log +
						// dashboard event, stop nudging. `0` disables (reverts to
						// per-burst + circuit-breaker only).
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
						// R1: in-flight nudge dedup — a nudge queued via
						// deliverAs:'followUp' must not be re-sent until it has been
						// consumed by an actual new agent turn (turn_start resets
						// retryNudgePending). Without this, a fast-erroring provider +
						// a per-turn nudge → N nudges queue up and pi dispatches N
						// retry turns, each re-submitting the same failing prompt
						// (the 2026-07-28 incident). errorRetryCount still advances
						// (this IS an error turn), so the per-burst max + circuit
						// breaker still bound the burst.
						if (runtime.rt.retryNudgePending) {
							runtime.dashboard.event("error_retry_dedup_skip", {
								category: effectiveCategory,
								count: runtime.rt.errorRetryCount,
								max,
								turnIndex: event.turnIndex,
							});
							return; // pending nudge not yet consumed — skip
						}
						// R1: gating backoff — errorRetryUntil is now GATING
						// (previously documented as non-gating). A nudge cannot fire
						// before the previous backoff elapses. This paces retries
						// (5s/10s/20s/30s by default) so a fast-erroring provider
						// doesn't slam N nudges in <1s.
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
						// Fire the retry nudge. Set pending (R1 dedup) + backoff
						// (R1 pacing) + session count (R2 cap) BEFORE the await so a
						// re-entrant turn_end during the send can't double-fire.
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
						// PREVENT-PI-003: user-role sendUserMessage only (queued + catch-guarded).
						await safeSendUserMessage(
							pi,
							"[mega-compact] the last turn ended with an error; please retry.",
						);
					}
				}
			}
		}
	} catch {
		/* non-fatal: a classifier/retry failure never breaks the agent loop */
	}
}
