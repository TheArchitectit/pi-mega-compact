/**
 * mega-events/agent-handlers.ts — agent/turn tracking event handlers.
 *
 * Registers agent_start/end (widget + status updates, durable-trim trigger)
 * and turn_start/end (turn index, memory auto-review, length-stop detection).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../mega-runtime.js";
import { piCompactWouldNoop, runMemoryReview } from "../mega-pipeline.js";
import { memoryReviewCadence, type MegaConfig } from "../mega-config.js";
import { recordScore, readLatestCacheHitPct } from "../../src/store/sqlite.js";
import { evaluateAndUnlockAchievements } from "../../src/store/sqlite/game-achievements.js";
import {
	ensureConversationIdFor,
	recordTurnWrite,
} from "../mega-turn-store.js";
import { isMegaCache } from "../../src/game/scoring.js";
import { resolveRepoRoot } from "../mega-config.js";
import {
	classifyError,
	classifyErrorDetailed,
	errorRetryBackoffMs,
	extractErrorSignature,
	isKnownRetryableTransient,
} from "./error-classifier.js";
import { safeSendUserMessage } from "./send-safe.js";
import { maybeSendProviderOutageAdvisory } from "./outage-advisor.js";
import { vectorStats } from "../../src/vectorStore.js";

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
		if (
			(config.auto || config.autoContinueLengthStop) &&
			runtime.activeAgents === 0
		) {
			try {
				const idle = ctx.isIdle?.() ?? true;
				const queued = ctx.hasPendingMessages?.() ?? false;
				const now = Date.now();
				// S38.5: read LIVE pressure from ctx.getContextUsage() instead of the
				// stale runtime.lastCtxTokens (only updated by the `context` event).
				// agent_end may fire without a preceding context event this turn (e.g.
				// a sub-agent settling), so the cached value can be null/stale and the
				// durable-trim branch would be unreachable. ctx.getContextUsage() is the
				// authoritative live reading (mirrors context-handler.ts:86). Fall back
				// to the cached value only if the ctx omits it.
				const liveUsage = ctx.getContextUsage?.();
				const liveTokens =
					typeof liveUsage?.tokens === "number"
						? liveUsage.tokens
						: (runtime.lastCtxTokens ?? 0);
				// Keep the cache fresh for snapshot()/diag regardless of which source we use.
				if (typeof liveUsage?.tokens === "number") {
					runtime.lastCtxTokens = liveUsage.tokens;
				}
				if (typeof liveUsage?.percent === "number") {
					runtime.lastCtxPercent = liveUsage.percent;
				}
				if (typeof liveUsage?.contextWindow === "number") {
					runtime.lastCtxWindow = liveUsage.contextWindow;
				}
				// DIAG (team-run relief): surface whether the agent is idle + over
				// threshold at agent_end so we can see if a mid-run durable-trim trigger
				// *should* have fired but didn't.
				const overThreshold = liveTokens >= runtime.effectiveThreshold;
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
				if (
					config.auto &&
					idle &&
					overThreshold &&
					now >= runtime.debounceUntil
				) {
					// COMPACT-DEDUP FIX: skip the manual durable-trim trigger when pi's
					// NATIVE auto-compaction just fired (or is in-flight). pi emits
					// agent_end BEFORE its own _checkCompaction (per its docstring:
					// "Called after agent_end and before prompt submission"), so a
					// synchronous `piCompactWouldNoop` branch check misses a native
					// compaction that hasn't appended its entry yet — calling
					// ctx.compact() then races with pi and throws "Already compacted"
					// to the user. The `lastNativeCompactAt` cooldown (updated by the
					// session_compact listener for EVERY compaction, native or
					// extension-supplied) closes that race window.
					//
					// S38.5: strict race guard widens the cooldown 10s -> 30s AND defers
					// ctx.compact() via setTimeout(500) with a re-check, so pi's
					// about-to-run native _checkCompaction can append its `compaction`
					// branch entry first (closes the first-race-in-burst window). Gated
					// by MEGACOMPACT_RACE_GUARD_STRICT (default true); false reverts to
					// the v0.7.4 synchronous 10s guard. Mirrors the legacy path in
					// context-handler.ts:258-287 so both call sites stay in sync.
					const cooldownMs = config.raceGuardStrict ? 30_000 : 10_000;
					const sinceCompact = now - (runtime.rt.lastNativeCompactAt ?? 0);
					if (sinceCompact < cooldownMs) {
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
						if (config.raceGuardStrict) {
							// Strict: defer ctx.compact() with a re-check so pi's
							// about-to-run native _checkCompaction can append its
							// `compaction` branch entry first. setTimeout(500) — pi's
							// compaction-summary append is async I/O, so queueMicrotask
							// would re-check before it lands.
							const stamp = runtime.rt.lastNativeCompactAt;
							const liveSid = runtime.rt.sessionId;
							setTimeout(() => {
								try {
									if (runtime.rt.sessionId !== liveSid) return; // session reset
									const since2 = now - (runtime.rt.lastNativeCompactAt ?? 0);
									if (
										runtime.rt.lastNativeCompactAt !== stamp &&
										since2 < cooldownMs
									)
										return;
									if (piCompactWouldNoop(ctx)) return;
									ctx.compact({
										customInstructions: undefined,
									}); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; deferred + re-validated.
								} catch {
									/* non-fatal */
								}
							}, 500);
						} else {
							ctx.compact({ customInstructions: undefined }); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; agent settled so no in-flight abort. Race-guarded by lastNativeCompactAt cooldown above (ctx.compact returns void → throw is surfaced by pi as compaction_end; the cooldown prevents the call entirely).
						}
						didDurableTrim = true;
					}
				}
				// Restart the agent after a mid-run durable trim (which stopped it), or
				// when it settled idle with queued work. Decoupled from `queued` for the
				// durable-trim case — see FIX note above. Debounced 30s; never blocks.
				const lengthStop =
					config.autoContinueLengthStop && runtime.rt.lengthStopPending;
				if (
					idle &&
					now >= runtime.resumeNudgeUntil &&
					((config.auto && (didDurableTrim || queued)) || lengthStop)
				) {
					runtime.resumeNudgeUntil = now + 30_000;
					if (runtime.rt.lengthStopPending) {
						runtime.rt.lengthStopPending = false; // one-shot: never re-fire for same stop
						runtime.dashboard.event("length_stop_continue", {
							turnIndex: runtime.currentTurn,
						});
						runtime.logger.info("length_stop_continue", {
							sessionId: runtime.rt.sessionId,
							didDurableTrim,
							queued,
						});
					}
					// S28: when a length-stop (max-output-token truncation) fired WITHOUT a durable trim, do NOT claim a compaction happened
					// (nothing was compacted on the low-pressure length path). Branch the message so the nudge matches reality.
					const nudgeMsg =
						lengthStop && !didDurableTrim
							? "[mega-compact] the last response hit the output-token cap; continue from where it stopped."
							: "[mega-compact] continue from the compacted context above.";
					await safeSendUserMessage(pi, nudgeMsg);
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
		// R4 (turn_end hygiene): a genuine new user prompt consumes any queued
		// retry nudge (deliverAs:'followUp') — pi dispatches it as the prompt for
		// this turn. Clearing retryNudgePending re-arms the dedup gate so the
		// next error turn can fire a fresh nudge (subject to backoff).
		// NOTE: the poisoned-repeat tracker (lastErrorText / errorTextRepeatCount)
		// is NOT reset here — a retry turn consuming the queued nudge is still the
		// same error sequence. The tracker resets on a SUCCESSFUL turn (null) or
		// when a different error text appears, not on the turn boundary.
		runtime.rt.retryNudgePending = false;
		runtime.dashboard.event("turn_start", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		runtime.dashboard.event("turn_end", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);

		// S53: consume staged recall blocks ONLY if they were actually injected
		// into a view this turn. If no context event fired (edge: turn ended
		// before any LLM call), recallInjectedThisTurn stays false and the blocks
		// remain staged for the next turn's first context event.
		if (config.recallTailInject && runtime.rt.recallInjectedThisTurn) {
			runtime.pendingRecallBlock = undefined;
			runtime.pendingMemoryRecallBlock = undefined;
			runtime.rt.recallInjectedThisTurn = false;
		}

		// S43 (per-turn tracking): record one turn row with the cached metrics so
		// the turn layer is queryable + forkable. Best-effort + non-fatal: a write
		// failure never breaks the agent loop.
		try {
			const convId = ensureConversationIdFor(
				config,
				runtime.rt.sessionId,
				runtime.currentStateDir,
			);
			recordTurnWrite(
				config,
				{
					conversationId: convId,
					sessionId: runtime.rt.sessionId,
					turnIndex: event.turnIndex,
					role: (event as { role?: string }).role ?? "assistant",
					endedAt: Date.now(),
					startedAt: undefined,
					ctxTokens: runtime.lastCtxTokens ?? undefined,
					ctxPercent: runtime.lastCtxPercent ?? undefined,
					pressureBand: runtime.pressureBand ?? undefined,
					modelId: runtime.currentModel?.modelId ?? undefined,
				},
				runtime.currentStateDir,
			);
		} catch {
			/* non-fatal: per-turn tracking never breaks the agent loop */
		}

		// S33: game-mode scoring — record turns + cache metrics per repo, and arm
		// the MEGA CACHE flare (oopsie gag) when the real dedup hit rate exceeds
		// 100%. Gated behind game_mode_on (no scoring when off). Best-effort +
		// non-fatal: a scoring failure must never break the agent loop (G6).
		try {
			if (runtime.getCachedGameState().game_mode_on) {
				const repo = resolveRepoRoot(ctx.cwd) ?? runtime.currentStateDir;
				const st = vectorStats(runtime.store, runtime.rt.sessionId);
				// C.3: prefer provider cache hit rate, fall back to dedup hit rate
				const providerPct = readLatestCacheHitPct(runtime.currentStateDir);
				const cachePct =
					providerPct != null ? providerPct : st.dedupHitRate * 100;
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
				const newTitles = evaluateAndUnlockAchievements(
					runtime.currentStateDir,
				);
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
					// (b) one-per-session advise message (throttled by poisonedAdviseSent)
					if (!runtime.rt.poisonedAdviseSent) {
						runtime.rt.poisonedAdviseSent = true;
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
	});
}
