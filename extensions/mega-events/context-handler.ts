/**
 * mega-events/context-handler.ts — the context event handler (auto-trigger).
 *
 * Delegate-shell (extensions split): handles the live-trim compaction pipeline —
 * DB-mirror append, fast-gate threshold check, pipeline invocation, legacy
 * durable compact, and the live-trim message reconstruction that feeds pi's
 * transformContext. The extracted pieces live in ./context-handler/:
 *  - messageText.ts    (messageContentText — best-effort text extraction)
 *  - tailResult.ts     (buildTailResult — recall-tail injection factory)
 *  - afterCompact.ts   (persistEpochAndMaintain — epoch/wiki/seed/dedup writes)
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ContextEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	openStore,
	resolveModelThreshold,
	DEFAULT_SAFETY_MARGIN_PCT,
	DEFAULT_FIRE_POINT_PCT,
} from "../../src/store/sqlite.js";
import { autoCompactCheck } from "../../src/compact.js";
import {
	estimateSessionTokens,
	estimateBlockTokens,
	estimateMessageTokens,
} from "../../src/tokens.js";
import type { MegaRuntime } from "../mega-runtime.js";
import { runCompact, piCompactWouldNoop } from "../mega-pipeline.js";
import {
	pressureFromPct,
	pressureRatio,
	type MegaConfig,
} from "../mega-config.js";
import { appendMirrorMessages } from "./mirror-append.js";
import { epochIdFor } from "../../src/mirror/epoch.js";
import { computeLiveTrimCut, liveTrimSummaryMessage } from "../mega-trim.js";
import { messageContentText } from "./context-handler/messageText.js";
import { buildTailResult } from "./context-handler/tailResult.js";
import { persistEpochAndMaintain } from "./context-handler/afterCompact.js";

/** Register the context event handler (live-trim auto-trigger). */
export function registerContextHandler(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// ---- Auto-trigger: live trim (compact and continue) + native durable ----
	// S16 redesign: we NO LONGER call ctx.compact() from the auto-trigger by
	// default. That mapped to pi's MANUAL compaction path, which abort()s the
	// in-flight turn (agent-session.js:1345) and stops the agent. Instead:
	//  - LIVE: return { messages: trimmedView } from the context event. This
	//    feeds pi's transformContext (sdk.js:226 → agent-loop.js:180) so the
	//    model sees a compacted window EVERY LLM call, with no abort. The turn
	//    continues. We persist our recall checkpoint (the durable value) first.
	//  - DURABLE: pi's NATIVE auto-compaction fires at agent-end
	//    (agent-session.js:1565), continues (return hasQueuedMessages()), and
	//    emits session_before_compact — where OUR driveNativeCompaction supplies
	//    the summary and pi truncates the transcript on disk. No ctx.compact().
	// Legacy: MEGACOMPACT_LEGACY_DURABLE_TRIM=true restores the v0.4.28 ctx.compact
	// path (kept one release as rollback).
	pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const pct = usage?.percent;
		const messages = event.messages;
		// S53: helper to inject the staged recall/memory block as a user-role
		// tail message at any view-return point. Returns undefined when nothing
		// is staged (or the flag is OFF) so the caller falls through to its
		// normal return.
		const tailResult = buildTailResult(runtime, config, messages);
		// Always track context for the dashboard/widget, even when auto is off.
		// (v0.8 regression: !config.auto gate sat above this, leaving ctx stats
		// null -> widget '?% / ?/?' when auto disabled. Track first, THEN gate.)
		// S40 fix: fall back to estimateSessionTokens(view) when the provider
		// doesn't report tokens (e.g. plexus / claude-mythos-5 via OpenRouter).
		// Without this, lastCtxTokens is null -> appendTokenSample (S39) never
		// fires -> Sessions chart + Overview per-repo stack + ContextGauge all
		// show empty/zero. Compute view lazily only when the fallback is needed
		// (at most one engineView call per context event; when auto is on and
		// usage.tokens is present, view is computed once below via reuse).
		const viewForFallback =
			usage?.tokens == null ? runtime.engineView(messages) : null;
		const currentTokens =
			usage?.tokens ??
			(viewForFallback != null
				? estimateSessionTokens(viewForFallback)
				: null) ??
			Math.round(((pct ?? 0) / 100) * (usage?.contextWindow ?? 0));
		runtime.lastCtxTokens = currentTokens ?? null;
		runtime.lastCtxPercent = pct ?? null;
		runtime.lastCtxWindow = usage?.contextWindow ?? 0;
		runtime.snapshot(ctx);
		if (!config.auto) {
			const tailed = tailResult();
			if (tailed) return tailed;
			return;
		}

		const view = viewForFallback ?? runtime.engineView(messages);

		// S27 DB-mirror: append incoming messages to raw_transcript.
		// Runs BEFORE fast-gate so every message is captured, even if we
		// don't compact this turn. Append is idempotent (content_hash PK).
		// F3: high-water mark (mirror-append.ts) skips already-processed
		// messages on subsequent events. On fork/rewind (shorter list or
		// boundary hash mismatch) the mark is dropped, falling back to a
		// full reprocess.
		if (config.dbMirror) {
			try {
				const db = openStore(runtime.currentStateDir);
				appendMirrorMessages(
					db,
					messages,
					runtime.rt.sessionId,
					epochIdFor(runtime.rt.sessionId),
					runtime.currentTurn,
				);
				// P2.2: populate conversation_thread + tool_results tables for
				// prompt-cache analytics and durable separation. The live-array
				// separation (buildSeparatedPrompt / buildCacheOptimizedPrompt in
				// tailResult above) is sufficient for the prompt-construction path;
				// these DB writes persist the split for post-hoc analysis, dashboard
				// queries, and future readers. Non-fatal — failure here never breaks
				// the agent loop (PREVENT-PI-004: zero network, local SQLite only).
				{
					const sid = runtime.rt.sessionId;
					const turn = runtime.currentTurn;
					const now = Date.now();
					const threadStmt = db.prepare(
						"INSERT OR IGNORE INTO conversation_thread (conversation_id, role, content, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)",
					);
					const toolStmt = db.prepare(
						"INSERT OR IGNORE INTO tool_results (conversation_id, role, content, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)",
					);
					for (const m of messages) {
						const role = m.role;
						const content = messageContentText(m);
						if (role === "user" || role === "assistant") {
							threadStmt.run(sid, role, content, turn, now);
						} else if (role === "toolResult" || role === "bashExecution") {
							toolStmt.run(sid, role, content, turn, now);
						}
					}
				}
			} catch (e) {
				runtime.logger.warn("db-mirror-append-fail", { error: String(e) });
			}
		}

		// S52 / v0.16.1: per-model threshold override. The user can tune the
		// fire point + safety margin PER MODEL (different providers' models range
		// 8K-1M+ context, so one global tier % is wrong). Falls back to env/default
		// when no override row exists. Computed once here + reused in the tail cap
		// below; the lookup is a single SQLite PK hit (cheap; cached after the
		// first read in a session).
		const _modelIdForThreshold = runtime.currentModel?.modelId ?? null;
		const _perModelThreshold = resolveModelThreshold(_modelIdForThreshold, {
			safetyMarginFallback: DEFAULT_SAFETY_MARGIN_PCT,
			firePointFallback:
				config.tierPct != null
					? Math.round(config.tierPct * 100)
					: DEFAULT_FIRE_POINT_PCT,
			stateDir: runtime.currentStateDir,
		});
		// S29 FAST GATE: drive the auto-trigger off the context % (the number the
		// menu bar shows), NOT the token count — the model under-reports tokens,
		// so a token-only gate misses the overshoot that causes max-output-tokens
		// truncation. The fire point is the per-model override when present,
		// otherwise the tier's percent threshold (tierPct) unless overridden by
		// MEGACOMPACT_AUTO_PCT_TRIGGER. `custom` (absolute
		// MEGACOMPACT_THRESHOLD_TOKENS, tierPct null) is an explicit opt-out of
		// percent scaling — it keeps the token gate. When pct is unavailable
		// (window unknown / a model that doesn't report percent) a tiered config
		// falls back to the token gate (S27 boot-fallback guarantee) instead of
		// skipping compaction — a percent-only gate would regress that.
		let gatePassed = false;
		if (config.tierPct != null && pct != null) {
			// Per-model override is a % (10-90); tierPct is a fraction (0.1-1.0).
			// Prefer the override; fall back to autoPctTrigger + tierPct.
			const tierPctFraction = config.autoPctTrigger ?? config.tierPct;
			const perModelFraction = _perModelThreshold.firePointPct / 100;
			const firePct =
				_modelIdForThreshold != null ? perModelFraction : tierPctFraction;
			gatePassed = pct / 100 >= firePct;
		} else {
			// custom tier OR tiered-but-pct-unavailable → token gate (S27 fallback).
			if (currentTokens < runtime.effectiveThreshold) {
				runtime.diagCtxFastGate++;
				return tailResult() ?? undefined;
			}
			const check = autoCompactCheck(currentTokens, runtime.effectiveThreshold); // SERVER-STYLE CONFIRM (local)
			if (!check.shouldCompact) {
				runtime.diagCtxNoCompact++;
				return tailResult() ?? undefined;
			}
			gatePassed = true;
		}
		if (!gatePassed) {
			runtime.diagCtxFastGate++;
			return tailResult() ?? undefined;
		}

		// D.2: Replay MUST be exempt from debounce — replay is free (no compute,
		// no re-write) and prevents unnecessary KV-cache invalidation. Check
		// replay FIRST, before debounce, so two context events <2s apart both
		// return the cached sentinel verbatim (re-stabilises the provider prefix).
		//
		// v0.8.6 cache-stability: replay the cached trim view when still in the
		// same compaction epoch AND context hasn't grown enough to warrant a
		// re-compact. Re-compact only when context grew >=config.recompactPctDelta%
		// of the window (percent basis) or >=50% of the effective threshold
		// (token basis, when percent is unavailable). The cached `cut` is only
		// valid while the transcript grows within the epoch — it is cleared on
		// session_compact (durable truncation) + resetRuntime, so we never replay
		// a stale cut into a truncated transcript (PREVENT-PI-001/002).
		if (
			runtime.trimCache &&
			runtime.trimCache.checkpointId === runtime.rt.lastCheckpointId &&
			runtime.trimCache.cut <= messages.length
		) {
			const grewEnough =
				pct != null && runtime.trimCache.ctxPct != null
					? pct - runtime.trimCache.ctxPct >= config.recompactPctDelta
					: currentTokens - (runtime.trimCache.ctxTokens ?? 0) >=
						runtime.effectiveThreshold * 0.5;
			if (!grewEnough) {
				const recent = messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002: cached `cut` was sanitized once by computeLiveTrimCut (src/boundary.ts) and replayed verbatim; the transcript only grows within an epoch (cache is cleared on durable truncation), so the preserved run still starts on a toolPair-safe index.
				runtime.diagLiveTrimFires++; // trim view returned this call (replay counts as a fire)
				runtime.diagLiveTrimReplays++;
				runtime.snapshot(ctx);
				// v0.8.7: shallow-copy the cached summary so pi's transformContext can't
				// mutate the shared reference across replays (audit P3).
				const replayView = [
					{ ...runtime.trimCache.summaryAgentMsg },
					...recent,
				];
				return tailResult(replayView) ?? { messages: replayView };
			}
			// else: context grew enough → fall through to re-compact (cache is stale)
		}

		// Debounce so we don't fire on every context event past threshold.
		// (Replay already returned above — only fresh compacts reach this point.)
		const now = Date.now();
		if (now < runtime.debounceUntil) {
			runtime.diagCtxDebounce++;
			return tailResult() ?? undefined;
		}
		runtime.debounceUntil = now + 2000;

		// Adaptive compression (Fix E): scale compression strength + keepFrom depth
		// with how close we are to the model context limit. Null-safe: when the
		// token-fallback path ran (pct unavailable) use the token-basis pressure
		// (the same basis the runtime `pressure` getter uses for custom/no-window).
		const pressure =
			pct != null
				? pressureFromPct(pct)
				: pressureRatio(currentTokens, runtime.effectiveThreshold);
		const ran = runCompact(pi, runtime, config, ctx, messages, {
			compressionPressure: pressure,
		});
		// D.3: skip paths fall back to replay instead of returning empty.
		// If runCompact skipped and we have a valid trimCache, replay it
		// (free stability win) — otherwise defer to the next event.
		if (ran.skipped) {
			runtime.diagCtxRunSkipped++;
			if (
				runtime.trimCache &&
				runtime.trimCache.checkpointId === runtime.rt.lastCheckpointId &&
				runtime.trimCache.cut <= messages.length
			) {
				const recent = messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002: cached `cut` was sanitized by computeLiveTrimCut (src/boundary.ts); replayed verbatim, transcript only grows within an epoch.
				runtime.diagLiveTrimFires++;
				runtime.diagLiveTrimReplays++;
				runtime.snapshot(ctx);
				const skipView = [{ ...runtime.trimCache.summaryAgentMsg }, ...recent];
				return tailResult(skipView) ?? { messages: skipView };
			}
			return tailResult() ?? undefined;
		}

		// S27 DB-mirror: write checkpoint_epoch + stamp turn epochs + auto-wiki +
		// topic seed + fire-and-forget dedup. Best-effort + non-fatal.
		await persistEpochAndMaintain(runtime, config, ran);

		// LEGACY path (rollback): v0.4.28 ctx.compact() + the no-op gate. The
		// manual compact path aborts the in-flight turn — only used behind the flag.
		// Read live from env (in addition to the load-time config) so the flag can be
		// toggled per-test without reloading the module; config.legacyDurableTrim is
		// the cached default. (Mirrors how piCompactWouldNoop re-reads its floor.)
		const legacy =
			config.legacyDurableTrim ||
			process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM === "true" ||
			process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM === "1";
		if (legacy) {
			// COMPACT-DEDUP FIX: same race guard as the agent_end path. Skip when a
			// NATIVE compaction just fired (avoids racing pi and surfacing a spurious
			// "Already compacted" / "Nothing to compact" toast). Uses lastNativeCompactAt
			// (NOT lastCompactAt, which runCompact also stamps for our own checkpoint).
			// S38.5: strict race guard widens the cooldown 10s -> 30s (gated by
			// MEGACOMPACT_RACE_GUARD_STRICT; false reverts to v0.7.4 10s).
			const cooldownMs = config.raceGuardStrict ? 30_000 : 10_000;
			const sinceCompact = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
			if (sinceCompact < cooldownMs || piCompactWouldNoop(ctx)) return;
			// S38.5: defer ctx.compact() with a re-check so pi's about-to-run native
			// _checkCompaction can append its `compaction` branch entry first (closes
			// the first-race-in-burst window). setTimeout(500) — pi's compaction-summary
			// append is async I/O, so queueMicrotask would re-check before it lands.
			// Non-strict (v0.7.4) keeps the synchronous call.
			if (config.raceGuardStrict) {
				const stamp = runtime.rt.lastNativeCompactAt;
				const liveSid = runtime.rt.sessionId;
				setTimeout(() => {
					try {
						if (runtime.rt.sessionId !== liveSid) return; // session reset
						const since2 = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
						if (runtime.rt.lastNativeCompactAt !== stamp && since2 < cooldownMs)
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
				ctx.compact({
					customInstructions: undefined,
				}); // race-guarded by lastNativeCompactAt cooldown (ctx.compact returns void → not catchable; the cooldown prevents the call)
			}
			return;
		}

		// S16 LIVE trim: collapse the compacted region to a summary + recent anchor.
		// Non-destructive: pi keeps the real transcript; only this LLM call sees the
		// trimmed window. We compute the cut on the engine view (pure, tested) then
		// slice the ORIGINAL pi AgentMessage[] from that index (lossless alignment,
		// mirroring dropCompactedRange) and prepend a user-role summary message.
		// A build failure or unsafe cut returns nothing (no trim this call — the
		// next context event retries). The anchor floor is read live from env (the
		// config value is the cached default) so it can be tuned per-test / per-run
		// without reloading the module.
		try {
			const anchorEnv = process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
			const anchorUserMessages =
				anchorEnv != null &&
				anchorEnv !== "" &&
				Number.isFinite(Number(anchorEnv))
					? Number(anchorEnv)
					: config.anchorUserMessages;
			const cut = computeLiveTrimCut(view, {
				compactedFrom: ran.result.compactedFrom,
				summary: ran.result.summary,
				anchorUserMessages,
				// CRITICAL-OVER ESCAPE HATCH: when context is at/over ~90% of the
				// window, relief takes priority over the anchor floor. Without this,
				// computeLiveTrimCut bails to null (can't satisfy the floor) and the
				// model is fed a raw overflow that errors every turn — the
				// "Already compacted" + overflow death-spiral (2026-08-01 incident).
				// A thin anchor is recoverable; an overflowed session is not.
				//
				// CRITICAL: pct is null for OpenAI-compatible providers that don't
				// report usage.percent (e.g. neuralwatt). Without the token-pressure
				// fallback the hatch never armed → cut=null → raw overflow → 400
				// "conversation too long even after compaction" (2026-08-03 incident
				// on glm-5.2-short, 200K window). Now also fires on pressure >= 0.9
				// (token-basis) so the hatch arms regardless of whether the provider
				// reports pct.
				criticalOver: (pct ?? 0) >= 90 || pressure >= 0.9,
			});
			if (cut === null) {
				runtime.diagCtxCutNull++;
				runtime.logger.info("live-trim-skip", {
					sessionId: runtime.rt.sessionId,
					compactedFrom: ran.result.compactedFrom,
					viewLen: view.length,
					anchorUserMessages,
					criticalOver: (pct ?? 0) >= 90,
				});
				return tailResult() ?? undefined; // unsafe / below anchor floor — no trim this call
			}
			const summaryMsg = liveTrimSummaryMessage({
				compactedFrom: ran.result.compactedFrom,
				summary: ran.result.summary,
				anchorUserMessages: config.anchorUserMessages,
			});
			// Synthesize a user-role AgentMessage carrying the compacted summary.
			const summaryAgentMsg = {
				role: "user" as const,
				content: summaryMsg.text,
				// v0.8.6: stable timestamp across the epoch (NOT Date.now()) so the
				// summary message bytes — and thus the KV-cache prefix — don't drift
				// on every replay within the same compaction epoch.
				timestamp: runtime.rt.lastCompactAt ?? Date.now(),
			} as unknown as AgentMessage;
			const recentRaw = messages.slice(cut); // guardrails-allow PREVENT-PI-002: `cut` is the pre-sanitized `compactedFrom` produced by src/boundary.ts computeDropRange, so the preserved run begins on a toolPair-safe index.

			// FIX 2 (2026-08-03 incident): TOKEN-BUDGET CAP on the live-trim view.
			// Compaction fires at tier% of the window (140K for a 200K window),
			// but a SINGLE turn can inject a huge tool output (file read, bash) that
			// jumps context from 139K → 199K+ before the next gate fires. When that
			// happens [summary + preserved tail] can STILL exceed the model window,
			// and the provider rejects with 400 "conversation too long even after
			// compaction". The anchor floor (PREVENT-PI-001) keeps ≥N user messages
			// but has NO token cap, so a 2-message tail of two 80K bash outputs sails
			// right past the window.
			//
			// Cap: when the model context window is known, reserve room for the
			// summary + the model's max output tokens + a 10% safety margin, then
			// drop oldest preserved messages from the front of `recentRaw` until the
			// tail fits. Never drops below the FINAL message (always keep the latest
			// turn so the agent can respond). This is a last-resort HARD cap — it
			// only fires when the preserved tail alone is oversized, which is rare.
			const ctxWindow = runtime.lastCtxWindow;
			// Reuse the per-model threshold resolved at the gate (single lookup).
			const modelThreshold = _perModelThreshold;
			// Reserve room for output tokens. Use the model's reported max output
			// when known; fall back to 10% of the window (scales with any model —
			// 20K for a 200K window, 100K for a 1M window) so we never let the
			// preserved tail eat the model's output budget when maxTokens is unknown.
			const maxOutput =
				runtime.currentModel?.maxTokens && runtime.currentModel.maxTokens > 0
					? runtime.currentModel.maxTokens
					: Math.ceil(ctxWindow * 0.1);
			let recent = recentRaw;
			if (ctxWindow > 0 && recentRaw.length > 1) {
				const summaryTokens = estimateBlockTokens(summaryMsg.text);
				// Reserve: summary + max output + per-model safety margin (0-20%).
				const safetyMargin = Math.ceil(
					ctxWindow * (modelThreshold.safetyMarginPct / 100),
				);
				const budget = ctxWindow - maxOutput - safetyMargin - summaryTokens;
				if (budget > 0) {
					// Walk recent from the front, dropping oldest first until the
					// remaining tail fits. Use the AgentMessage→engine-text estimate via
					// messageContentText (already imported) + estimateMessageTokens.
					let tailTokens = 0;
					for (let i = recentRaw.length - 1; i >= 0; i--) {
						const m = recentRaw[i];
						tailTokens += estimateMessageTokens({
							text: messageContentText(m),
						});
						if (tailTokens > budget) {
							// Keep from i+1 onward; but never fewer than the final message.
							const startIdx = Math.min(i + 1, recentRaw.length - 1);
							if (startIdx > 0) {
								recent = recentRaw.slice(startIdx);
								runtime.logger.warn("live-trim-tail-cap", {
									sessionId: runtime.rt.sessionId,
									dropped: startIdx,
									tailTokens,
									safetyMarginPct: modelThreshold.safetyMarginPct,
									budget,
									ctxWindow,
								});
							}
							break;
						}
					}
				}
			}

			// v0.8.6: cache the trim view so subsequent gated calls in this epoch
			// replay it verbatim (stabilizing the KV-cache prefix) instead of
			// regenerating a fresh summary + sentinel every fire.
			runtime.trimCache = {
				// v0.8.7: key the replay cache on the STABLE epoch signal
				// (rt.lastCheckpointId) instead of ran.result.checkpointId, which is
				// dedup-volatile: on a re-compact that dedups onto a DIFFERENT existing
				// checkpoint, result.checkpointId is the matched id (engine.ts:188) while
				// lastCheckpointId is only updated on a genuinely new checkpoint
				// (compact.ts:100-104). Keying on result.checkpointId would make
				// trimCache.checkpointId != rt.lastCheckpointId forever after that
				// dedup fire, disabling replay for the rest of the epoch (the
				// alternating cache-miss that 0.8.6 meant to fix). Prefer the stable
				// signal; fall back to result.checkpointId then the epoch timestamp
				// only for the no-checkpoint edge case.
				checkpointId:
					runtime.rt.lastCheckpointId ??
					ran.result.checkpointId ??
					`epoch-${runtime.rt.lastCompactAt ?? Date.now()}`,
				cut,
				summaryAgentMsg,
				ctxPct: pct ?? null,
				ctxTokens: currentTokens,
			};
			runtime.snapshot(ctx);
			// DIAG (team-run relief): confirm the live trim actually fires + how big
			// the window still is. The return is non-durable (per-LLM-call only), so
			// this is the signal that the model is being fed a compacted view while
			// the on-disk transcript + context meter keep growing.
			runtime.diagLiveTrimFires++;
			runtime.logger.info("live-trim", {
				sessionId: runtime.rt.sessionId,
				inputMsgs: messages.length,
				outputMsgs: recent.length + 1,
				compactedFrom: cut,
				ctxPct: pct,
				ctxTokens: usage?.tokens ?? null,
			});
			return (
				tailResult([summaryAgentMsg, ...recent]) ?? {
					messages: [summaryAgentMsg, ...recent],
				}
			);
		} catch {
			runtime.diagCtxThrown++;
			return tailResult() ?? undefined; // non-fatal: no trim this call; the next context event retries
		}
	});
}
