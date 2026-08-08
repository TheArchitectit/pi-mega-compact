/**
 * agent-handlers/agentEndHandler.ts — the pi `agent_end` handler body.
 *
 * Extracted from agent-handlers.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Contains the live-agent status-line updates,
 * the S16/S38.5 mid-run durable trim (race-guarded, deferred ctx.compact), the
 * S28 length-stop nudge, and the R4-R11 error-retry safety net.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../mega-runtime.js";
import { piCompactWouldNoop } from "../../mega-pipeline.js";
import type { MegaConfig } from "../../mega-config.js";
import { safeSendInvisibleMessage } from "../send-safe.js";

/** Handle the `agent_end` pi event. Non-fatal end-to-end. */
export async function handleAgentEnd(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): Promise<void> {
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
				// CRITICAL-OVER ESCAPE HATCH: when context is critically over the
				// window (>= 90%), force the durable ctx.compact() even if
				// piCompactWouldNoop says it would no-op ("Already compacted").
				// Without this, the on-disk transcript never truncates and the
				// session stays overflowed on every resume — the "Already
				// compacted" + overflow death-spiral (2026-08-01 incident). The
				// cooldown still applies (we don't spam compact), but the no-op
				// gate is bypassed when critical. pi's ctx.compact() may throw
				// "Already compacted" in the truly-no-op case — wrapped in
				// try/catch so the throw is non-fatal.
				const criticalOver = (runtime.lastCtxPercent ?? 0) >= 90;
				if (sinceCompact < cooldownMs) {
					runtime.diagAgentEndDurableSkipRecent++;
				} else if (criticalOver || !piCompactWouldNoop(ctx)) {
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
						const liveCritical = criticalOver;
						setTimeout(() => {
							try {
								if (runtime.rt.sessionId !== liveSid) return; // session reset
								// IMPORTANT: recompute Date.now() inside the timeout.
								// `now` above is the durable-trim handler's timestamp and can be
								// ~500ms stale by the time this callback runs.
								const since2 = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
								if (
									runtime.rt.lastNativeCompactAt !== stamp &&
									since2 < cooldownMs
								)
									return;
								// CRITICAL-OVER ESCAPE HATCH: bypass the no-op gate when
								// critical (captured at handler time) so the durable trim fires.
								if (!liveCritical && piCompactWouldNoop(ctx)) return;
								ctx.compact({
									customInstructions: undefined,
								}); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; deferred + re-validated. May throw "Already compacted" when the escape hatch forces it — caught below.
							} catch {
								/* non-fatal: "Already compacted" throws are expected when the critical-over hatch forces a no-op compact */
							}
						}, 500);
					} else {
						try {
							ctx.compact({ customInstructions: undefined }); // guardrails-allow PREVENT-PI-004: local ctx.compact() — no network; agent settled so no in-flight abort. May throw "Already compacted" when the critical-over escape hatch forces it — caught.
						} catch {
							/* non-fatal */
						}
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
				await safeSendInvisibleMessage(pi, nudgeMsg);
			}
		} catch {
			/* non-fatal: a failed nudge never blocks */
		}
	}
	runtime.snapshot(ctx);
}
