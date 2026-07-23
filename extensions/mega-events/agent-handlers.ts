/**
 * mega-events/agent-handlers.ts — agent/turn tracking event handlers.
 *
 * Registers agent_start/end (widget + status updates, durable-trim trigger)
 * and turn_start/end (turn index, memory auto-review, length-stop detection).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MegaRuntime } from "../mega-runtime.js";
import {
	piCompactWouldNoop,
	runMemoryReview,
} from "../mega-pipeline.js";
import {
	memoryReviewCadence,
	type MegaConfig,
} from "../mega-config.js";
import { recordScore } from "../../src/store/sqlite.js";
import { evaluateAndUnlockAchievements } from "../../src/store/sqlite/game-achievements.js";
import { isMegaCache } from "../../src/game/scoring.js";
import { resolveRepoRoot } from "../mega-config.js";
import { classifyError, errorRetryBackoffMs } from "./error-classifier.js";

/** Register agent/turn tracking event handlers. */
export function registerAgentHandlers(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// ---- Agent tracking for real-time widget + status-line updates ---------
	pi.on("agent_start", async (_event, ctx) => {
		runtime.activeAgents++;
		runtime.dashboard.event("agent_start", {
			activeAgents: runtime.activeAgents,
		});
		// Surface live agent activity on the status line (toolbar), not just the
		// above-editor widget — otherwise concurrent agents look frozen.
		runtime.setStatus(
			ctx,
			`mega-compact: ▶ ${runtime.activeAgents} agent${runtime.activeAgents === 1 ? "" : "s"}`,
		);
		runtime.snapshot(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		runtime.activeAgents = Math.max(0, runtime.activeAgents - 1);
		runtime.dashboard.event("agent_end", {
			activeAgents: runtime.activeAgents,
		});
		if (runtime.activeAgents > 0) {
			runtime.setStatus(
				ctx,
				`mega-compact: ▶ ${runtime.activeAgents} agent${runtime.activeAgents === 1 ? "" : "s"}`,
			);
		} else {
			runtime.setStatus(
				ctx,
				config.auto ? "mega-compact: ready" : "mega-compact: manual only",
			);
		}
		// S16 continuation fallback: if the turn settled idle right after a live-trim
		// compaction AND there is queued work AND we haven't nudged recently, nudge
		// once so the agent continues (the live trim should make this rare). Guarded
		// to never busy-loop: one nudge per 30s, only when truly idle + queued.
		if ((config.auto || config.autoContinueLengthStop) && runtime.activeAgents === 0) {
			try {
				const idle = ctx.isIdle?.() ?? true;
				const queued = ctx.hasPendingMessages?.() ?? false;
				const now = Date.now();
				// DIAG (team-run relief): surface whether the agent is idle + over
				// threshold at agent_end so we can see if a mid-run durable-trim trigger
				// *should* have fired but didn't.
				const overThreshold =
					(runtime.lastCtxTokens ?? 0) >= runtime.effectiveThreshold;
				runtime.diagAgentEndIdle++;
				runtime.logger.info("agent-end-idle", {
					sessionId: runtime.rt.sessionId,
					idle,
					queued,
					overThreshold,
					ctxPct: runtime.lastCtxPercent,
					ctxTokens: runtime.lastCtxTokens,
					thresholdTokens: config.thresholdTokens,
					wouldNudge:
						idle &&
						(queued || overThreshold) &&
						now >= runtime.resumeNudgeUntil,
				});
				// S16+S24: MID-RUN DURABLE TRIM. During a long team run (sub-agents),
				// pi's native durable compaction only fires from _checkCompaction at
				// PARENT settle (agent-session.js:760/844), so the on-disk transcript +
				// context meter balloon to ~150k and never relieve until the very end
				// ("compacts but doesn't resume"). agent_end with activeAgents===0 is a
				// SAFE, settled point: calling ctx.compact() here does NOT abort an
				// in-flight turn (the S16 danger is only mid-turn). ctx.compact() runs
				// pi's flow, which fires our session_before_compact handler to supply
				// the durable trim (truncates the transcript from firstKeptEntryId).
				// Guarded three ways: only when truly idle + over threshold, only when
				// pi would actually compact (piCompactWouldNoop skips the user-facing
				// no-op throw), and debounced (one durable trim per 2s) to avoid
				// thrashing the transcript while sub-agents keep settling.
				//
				// FIX "compacts but doesn't resume": the manual ctx.compact() path
				// STOPS the agent loop (agent-session.js:1345). The old resume-nudge
				// was gated on `queued`, so when a sub-agent settled with no
				// *immediately* queued message, the trim fired but the nudge did not,
				// and the (stopped) session hung. The trim still fires on
				// `idle && overThreshold` — we intentionally do NOT add a `!queued`
				// guard, because that would suppress mid-run relief exactly during
				// team-run waves where queued is usually true and relief is needed
				// most. Instead we DECOUPLE the nudge from `queued`: after a durable
				// trim we ALWAYS nudge so the agent reliably restarts. Debounced 30s.
				let didDurableTrim = false;
				if (config.auto && idle && overThreshold && now >= runtime.debounceUntil) {
					// COMPACT-DEDUP FIX: skip the manual durable-trim trigger when pi's
					// NATIVE auto-compaction just fired (or is in-flight). pi emits
					// agent_end BEFORE its own _checkCompaction (per its docstring:
					// "Called after agent_end and before prompt submission"), so a
					// synchronous `piCompactWouldNoop` branch check misses a native
					// compaction that hasn't appended its entry yet — calling
					// ctx.compact() then races with pi and throws "Already compacted"
					// to the user. The `lastCompactAt` cooldown (updated by the
					// session_compact listener for EVERY compaction, native or
					// extension-supplied) closes that race window.
					const sinceCompact = now - (runtime.rt.lastNativeCompactAt ?? 0);
					if (sinceCompact < 10_000) {
						runtime.diagAgentEndDurableSkipRecent++;
					} else if (!piCompactWouldNoop(ctx)) {
						runtime.debounceUntil = now + 2000;
						runtime.diagAgentEndDurable++;
						runtime.logger.info("agent-end-durable-trigger", {
							sessionId: runtime.rt.sessionId,
							ctxTokens: runtime.lastCtxTokens,
							thresholdTokens: config.thresholdTokens,
							queued,
						});
						ctx.compact({ customInstructions: undefined }); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; agent settled so no in-flight abort. Race-guarded by lastCompactAt cooldown above (ctx.compact returns void → throw is surfaced by pi as compaction_end; the cooldown prevents the call entirely).
						didDurableTrim = true;
					}
				}
				// Restart the agent after a mid-run durable trim (which stopped it), or
				// when it settled idle with queued work. Decoupled from `queued` for the
				// durable-trim case — see FIX note above. Debounced 30s; never blocks.
				const lengthStop = config.autoContinueLengthStop && runtime.rt.lengthStopPending;
				if (
					idle &&
					now >= runtime.resumeNudgeUntil &&
					((config.auto && (didDurableTrim || queued)) || lengthStop)
				) {
					runtime.resumeNudgeUntil = now + 30_000;
					if (runtime.rt.lengthStopPending) {
						runtime.rt.lengthStopPending = false; // one-shot: never re-fire for same stop
						runtime.dashboard.event("length_stop_continue", { turnIndex: runtime.currentTurn });
						runtime.logger.info("length_stop_continue", {
						sessionId: runtime.rt.sessionId,
						didDurableTrim,
						queued,
						});
					}
					// S28: when a length-stop (max-output-token truncation) fired WITHOUT a durable trim, do NOT claim a compaction happened
					// (nothing was compacted on the low-pressure length path). Branch the message so the nudge matches reality.
					const nudgeMsg = lengthStop && !didDurableTrim
						? "[mega-compact] the last response hit the output-token cap; continue from where it stopped."
						: "[mega-compact] continue from the compacted context above.";
					pi.sendUserMessage(nudgeMsg);
				}
			} catch {
				/* non-fatal: a failed nudge never blocks */
			}
		}
		runtime.snapshot(ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		runtime.currentTurn = event.turnIndex;
		runtime.rt.lengthStopPending = false; // S28: re-arm defensively each user turn
		runtime.rt.errorRetryCount = 0; // S38: reset error-retry counter each user turn
		runtime.dashboard.event("turn_start", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		runtime.dashboard.event("turn_end", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);

		// S33: game-mode scoring — record turns + cache metrics per repo, and arm
		// the MEGA CACHE flare (oopsie gag) when the real dedup hit rate exceeds
		// 100%. Gated behind game_mode_on (no scoring when off). Best-effort +
		// non-fatal: a scoring failure must never break the agent loop (G6).
		try {
			if (runtime.getCachedGameState().game_mode_on) {
				const repo = resolveRepoRoot(ctx.cwd) ?? runtime.currentStateDir;
				const st = runtime.store.stats(runtime.rt.sessionId);
				const cachePct = st.dedupHitRate * 100;
				const modelId = runtime.currentModel?.modelId ?? "unknown";
				recordScore(runtime.currentStateDir, {
					repo_root: repo,
					metric: "turns",
					value: runtime.currentTurn,
					meta: { modelId, turnIndex: event.turnIndex },
				});
				recordScore(runtime.currentStateDir, {
					repo_root: repo,
					metric: "cache",
					value: cachePct,
					meta: {
						hits: st.dedupCollapsed + runtime.rt.recallInjections,
						lookups: st.checkpointCount,
					},
				});
				// MEGA CACHE: the real ratio >1 (dedupHitRate>1) → trophy row + flare.
				if (isMegaCache(cachePct)) {
					recordScore(runtime.currentStateDir, {
						repo_root: repo,
						metric: "mega_cache",
						value: cachePct,
						meta: { peakPct: cachePct, firstSeenTs: Date.now() },
					});
					runtime.armMegaCacheFlare(cachePct);
				}
				// S35: evaluate achievements after scoring; arm a one-time flare for
				// the newly-unlocked ones (consumed by snapshot() → widget toast).
				const newTitles = evaluateAndUnlockAchievements(runtime.currentStateDir);
				if (newTitles.length) runtime.armAchievementFlare(newTitles);
			}
		} catch {
			/* non-fatal: scoring must never break the agent loop */
		}

		// S20+S24: auto-review the conversation and persist durable memories. The
		// review cadence scales with pressure (memoryReviewCadence): as context
		// fills, the conversation is reviewed more often so memories keep pace with
		// faster churn. Best-effort + non-fatal: a review failure must never break
		// the agent loop. Debounced by the pressure-adjusted interval.
		if (config.memoryAutoReview && runtime.currentTurn > 0) {
			const cadence = memoryReviewCadence(
				runtime.pressureBand,
				config.memoryReviewInterval,
			);
			if (runtime.currentTurn % cadence === 0) {
				// S20+S24: review the conversation and persist durable memories. The
				// cadence scales with pressure (memoryReviewCadence): as context fills,
				// the conversation is reviewed more often so memories keep pace with
				// faster churn. Shared runMemoryReview body (also used on compact).
				const entries = ctx.sessionManager.getEntries();
				const view = runtime.engineView(
					entries.flatMap((e: any) => (e.message ? [e.message] : [])),
				);
				await runMemoryReview(runtime, view, "turn");
			}
		}

		// S28: detect max-output-token truncation. event.message.stopReason is the
		// pi-ai StopReason union; 'length' == generation hit max_tokens OUTPUT cap
		// (INPUT-orthogonal to context-window overflow). Arm the agent_end nudge.
		if (
			config.autoContinueLengthStop &&
			event.message.role === "assistant" &&
			event.message.stopReason === "length"
		) {
			runtime.rt.lengthStopPending = true;
			runtime.dashboard.event("length_stop", { turnIndex: event.turnIndex });
		}

		// S38: broader error-retry safety net. S28 only catches stopReason==='length';
		// this catches ALL other error types (provider failure, network timeout, 5xx,
		// 429, auth, compaction-noop) that surface at turn_end. Non-fatal: wrapped in
		// try/catch so a classifier/retry failure never breaks the agent loop.
		// PREVENT-PI-003: retry nudge fires via pi.sendUserMessage (user-role).
		try {
			// (1) S28 owns length — skip the classifier entirely for it.
			const sr = (event.message as { stopReason?: string } | undefined)?.stopReason;
			if (sr === 'length') {
				// S28 handles; nothing for S38 to do here.
			} else {
				const category = classifyError(event.message);
				if (category === null) {
					// (3) success / normal flow / unknown-but-non-retryable — reset.
					runtime.rt.errorRetryCount = 0;
					runtime.rt.consecutiveErrors = 0; // S38.6: circuit-breaker reset on success
				} else if (category === 'compaction-noop') {
					// (4) pi race / manual compact catch — NOT retryable. The compaction
					// already succeeded via pi's native path; retrying would race again
					// (FAIL-2026071701). Log a diagnostic, reset the counter, and surface
					// the original error WITHOUT firing a retry nudge.
					runtime.rt.errorRetryCount = 0;
					runtime.rt.consecutiveErrors = 0; // S38.6: circuit-breaker reset
					runtime.dashboard.event('compaction_noop_diagnostic', {
						turnIndex: event.turnIndex,
						sessionId: runtime.rt.sessionId,
					});
					runtime.logger.info('compaction-noop-diagnostic', {
						sessionId: runtime.rt.sessionId,
						turnIndex: event.turnIndex,
					});
				} else {
					// (5) transient or permanent — retry with exponential backoff.
					// S38.7: hard-stop switch — bypass ALL retry logic when set.
					if (config.errorRetryHardStop) {
						runtime.rt.errorRetryCount = 0;
						runtime.dashboard.event('error_retry_disabled', {
							category,
							turnIndex: event.turnIndex,
							reason: 'hard-stop',
						});
						return; // early exit — no retry
					}
					// S38.6: circuit-breaker — stop retrying after too many consecutive errors.
					runtime.rt.consecutiveErrors++;
					if (runtime.rt.consecutiveErrors > config.maxConsecutiveErrors) {
						runtime.dashboard.event('error_retry_circuit_open', {
							consecutive: runtime.rt.consecutiveErrors,
							max: config.maxConsecutiveErrors,
							turnIndex: event.turnIndex,
						});
						runtime.logger.warn('error-retry-circuit-open', {
							sessionId: runtime.rt.sessionId,
							consecutive: runtime.rt.consecutiveErrors,
							max: config.maxConsecutiveErrors,
						});
						return; // early exit — circuit breaker tripped
					}
					const max =
						category === 'transient'
							? config.autoRetryTransientMax
							: config.autoRetryPermanentMax;
					// max === 0 disables the category entirely (revert to S28-only).
					if (max <= 0) {
						runtime.rt.errorRetryCount = 0;
					} else {
						runtime.rt.errorRetryCount++;
						if (runtime.rt.errorRetryCount > max) {
							// Exhausted — surface the error, reset for the next burst.
							runtime.dashboard.event('error_retry_exhausted', {
								category,
								count: runtime.rt.errorRetryCount,
								max,
								turnIndex: event.turnIndex,
							});
							runtime.logger.info('error-retry-exhausted', {
								sessionId: runtime.rt.sessionId,
								category,
								count: runtime.rt.errorRetryCount,
								max,
							});
							runtime.rt.errorRetryCount = 0;
						} else {
							const now = Date.now();
							// Debounce: don't fire if a prior retry nudge is still in its
							// backoff window (prevents a tight turn_end loop from
							// busy-looping before the backoff elapses).
							if (now >= runtime.rt.errorRetryUntil) {
								runtime.rt.errorRetryUntil =
									now + errorRetryBackoffMs(runtime.rt.errorRetryCount);
								runtime.dashboard.event('error_retry', {
									category,
									count: runtime.rt.errorRetryCount,
									max,
									turnIndex: event.turnIndex,
								});
								runtime.logger.info('error-retry', {
									sessionId: runtime.rt.sessionId,
									category,
									count: runtime.rt.errorRetryCount,
									max,
								});
								// PREVENT-PI-003: user-role sendUserMessage only.
								pi.sendUserMessage(
									'[mega-compact] the last turn ended with an error; please retry.',
								);
							}
						}
					}
				}
			}
		} catch {
			/* non-fatal: a classifier/retry failure never breaks the agent loop */
		}
	});
}
