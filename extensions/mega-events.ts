/**
 * mega-events.ts — the pi lifecycle event handlers.
 *
 * Wires every pi event the extension listens for: model/provider capture,
 * session lifecycle + state reset, auto-inline injection, agent/turn tracking,
 * and the auto-trigger compaction pipeline. Keeps the shared MegaRuntime in
 * sync and delegates the heavy lifting to the pipeline + command modules.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ContextEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeSessionId } from "../src/store.js";
import { openStore, appendRawTranscript, writeCheckpointEpoch, autoMaintain, type CheckpointEpoch } from "../src/store/sqlite.js";
import { epochIdFor } from "../src/mirror/epoch.js";
import { autoCompactCheck } from "../src/compact.js";
import { estimateSessionTokens, estimateBlockTokens } from "../src/tokens.js";
import {
	type MegaRuntime,
	recentUserQuery,
	WIDGET_KEY,
} from "./mega-runtime.js";
import {
	runCompact,
	doRecall,
	doRecallAsync,
	piCompactWouldNoop,
	runMemoryReview,
} from "./mega-pipeline.js";
import { recallMemoriesAndInline } from "../src/recall.js";
import {
	driveNativeCompaction,
	type NativeCompactionResult,
} from "./mega-compact-driver.js";
import { computeLiveTrimCut, liveTrimSummaryMessage } from "./mega-trim.js";
import {
	pressureFromPct,
	memoryReviewCadence,
	type MegaConfig,
} from "./mega-config.js";
import type { RawTranscriptRow } from "../src/store/sqlite.js";
import { createHash } from "node:crypto";

/**
 * Convert a pi AgentMessage to a RawTranscriptRow for the DB mirror.
 * content_bytes is canonical JSON (sorted keys) for deterministic hashing.
 * Returns null if the message has no usable content.
 */
function toRawTranscriptRow(
	msg: AgentMessage,
	sessionId: string,
	epochId: string,
): RawTranscriptRow | null {
	// Narrow to Message union (has content + timestamp).
	const m = msg as { role?: string; content?: unknown; timestamp?: number; toolName?: string };
	const content = m.content;
	if (content == null || content === "") return null;
	// Canonical form: sort object keys for deterministic hashing.
	const contentBytes = typeof content === "string"
		? content
		: JSON.stringify(content, Object.keys(content as object).sort());
	const contentHash = createHash("sha256").update(contentBytes).digest("hex");
	return {
		contentHash,
		sessionId,
		seq: 0, // assigned by appendRawTranscript (COALESCE(MAX(seq),0)+1)
		role: m.role ?? "unknown",
		contentBytes,
		toolName: m.toolName ?? null,
		messageTimestamp: m.timestamp ?? null,
		checkpointEpoch: epochId,
	};
}

/**
 * DIAG accessor for the headless test harness: the most recently constructed
 * MegaRuntime, so a test that loads the compiled extension via its default
 * export can read diag counters (diagLiveTrimFires / diagBeforeCompactFires /
 * diagBeforeCompactSupplied / diagAgentEndIdle) after firing synthetic events.
 * No-op in production — nothing reads this outside tests.
 */
export let lastRuntime: MegaRuntime | undefined;

/** Register all pi lifecycle event handlers. */
export function registerEventHandlers(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	lastRuntime = runtime;
	// ---- Session lifecycle (state reset points) -------------------------------
	// Capture model/provider whenever it changes (drives real cost estimation).
	pi.on("model_select", async (_event, ctx) => {
		runtime.captureModel(ctx);
		runtime.snapshot(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		runtime.resetRuntime(ctx.sessionManager.getSessionId());
		runtime.captureModel(ctx); // best-effort: ctx.model may be set by session start
		runtime.setStatus(
			ctx,
			config.auto ? "mega-compact: ready" : "mega-compact: manual only",
		);
		// S21: clear any stale memory block from a prior session.
		runtime.pendingMemoryRecallBlock = undefined;
		// Auto-inline on resume/fork/continue: stage the most relevant checkpoints
		// so the next before_agent_start prepends them to the system prompt.
		// Triggered whenever this session already has persisted checkpoints AND a
		// usable query — that covers reason "resume"/"fork" (explicit) and
		// reason "startup" (e.g. `pi --continue`s an existing session, which still
		// emits "startup" but with a populated message window). A brand-new empty
		// session has no checkpoints, so it's naturally excluded.
		if (config.autoInline) {
			const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
			const query = recentUserQuery(ctx);
			if (query && runtime.store.stats(sid).checkpointCount > 0) {
				// S17: use the async variant on resume so cross-repo HNSW recall can
				// augment when this repo's store is thin. session_start is an async-safe
				// point (unlike the mid-turn context handler, which stays sync).
				const r = await doRecallAsync(runtime, config, ctx, query, "resume", {
					crossRepo: config.crossRepoEnabled,
				});
				if (!r.empty) {
					runtime.pendingRecallBlock = r.block;
					const crossLabel = r.toInject.some((h) => h.repoId)
						? " (cross-repo)"
						: "";
					runtime.setStatus(
						ctx,
						`mega-compact: recalled ${r.toInject.length} chkpt${crossLabel}`,
					);
					runtime.logger.info("auto-inline", {
						reason: event.reason,
						query,
						injected: r.toInject.map((h) => h.checkpoint.checkpointId),
						crossRepo: r.toInject.some((h) => h.repoId),
					});
				}
			}
			// S21: parallel memory recall. Same async context so we can await without
			// breaking the handler contract. Best-effort — never throws.
			try {
				const mr = await recallMemoriesAndInline({
					query,
					stateDir: runtime.getStateDir(),
					limit: 5,
					crossRepo: config.crossRepoEnabled,
					crossRepoCosine: config.crossRepoCosine,
				});
				if (!mr.empty) runtime.pendingMemoryRecallBlock = mr.block;
			} catch (err) {
				runtime.logger.warn("memory-recall skipped", { err: String(err) });
			}
		}
		// S27 Task 10: best-effort auto-maintenance on session start (prune rows
		// older than 30d, checkpoint WAL if >10MB, VACUUM if DB >100MB + >20%
		// freelist). Never blocks session start — swallows errors and logs a
		// one-line summary for diagnostics.
		try {
			const m = autoMaintain(runtime.currentStateDir);
			if (m && !m.endsWith("nothing to do")) runtime.logger.info("db-auto-maintain", { result: m });
		} catch (e) {
			runtime.logger.warn("db-auto-maintain-fail", { error: String(e) });
		}
		runtime.dashboard.event("session_start", {
			reason: event.reason,
			sessionId: runtime.rt.sessionId,
		});
		runtime.snapshot(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Branch navigation invalidates region indexes — reset checkpoint memory but
		// keep the on-disk store (markers replayed from entries below if needed).
		runtime.resetRuntime(ctx.sessionManager.getSessionId());
		runtime.setStatus(ctx, "mega-compact: ready (branch)");
		if (config.autoInline) {
			const query = recentUserQuery(ctx);
			if (query) {
				const r = doRecall(runtime, config, ctx, query, "resume");
				if (!r.empty) {
					runtime.pendingRecallBlock = r.block;
					runtime.logger.info("auto-inline", {
						reason: "session_tree",
						query,
						injected: r.toInject.map((h) => h.checkpoint.checkpointId),
					});
				}
				// S21: parallel memory recall. Trigram embedder is sub-ms; await is fine.
				try {
					const mr = await recallMemoriesAndInline({
						query,
						stateDir: runtime.getStateDir(),
						limit: 5,
						crossRepo: config.crossRepoEnabled,
						crossRepoCosine: config.crossRepoCosine,
					});
					if (!mr.empty) runtime.pendingMemoryRecallBlock = mr.block;
				} catch (err) {
					runtime.logger.warn("memory-recall skipped", { err: String(err) });
				}
			}
		}
		runtime.dashboard.event("session_tree", {
			sessionId: runtime.rt.sessionId,
		});
		runtime.snapshot(ctx);
	});

	// ---- Auto-inline injection point: prepend staged recall to systemPrompt ----
	pi.on("before_agent_start", async (event, ctx) => {
		runtime.captureModel(ctx); // most reliable point ctx.model is populated
		const cpBlock = runtime.pendingRecallBlock;
		const memBlock = runtime.pendingMemoryRecallBlock;
		if (!cpBlock && !memBlock) return;
		runtime.pendingRecallBlock = undefined;
		runtime.pendingMemoryRecallBlock = undefined;
		const composed = [cpBlock, memBlock].filter(Boolean).join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${composed}` };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtime.setStatus(ctx, undefined);
		runtime.activeAgents = 0;
		runtime.currentTurn = 0;
		ctx.ui.setWidget(WIDGET_KEY, [], { placement: "aboveEditor" });
	});

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
		runtime.dashboard.event("turn_start", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		runtime.dashboard.event("turn_end", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);

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
	});

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
		if (!config.auto) return;
		const usage = ctx.getContextUsage();
		const pct = usage?.percent;
		// Always track context for the dashboard, even if we return early below.
		runtime.lastCtxTokens = usage?.tokens ?? null;
		runtime.lastCtxPercent = pct ?? null;
		runtime.lastCtxWindow = usage?.contextWindow ?? 0;
		runtime.snapshot(ctx);
		if (pct == null) return;

		const messages = event.messages;
		const view = runtime.engineView(messages);
		const currentTokens =
			usage?.tokens ??
			estimateSessionTokens(view) ??
			Math.round((pct / 100) * (usage?.contextWindow ?? 0));

		// S27 DB-mirror: append ALL incoming messages to raw_transcript.
		// Runs BEFORE fast-gate so every message is captured, even if we
		// don't compact this turn. Append is idempotent (content_hash PK).
		if (config.dbMirror) {
			try {
				const db = openStore(runtime.currentStateDir);
				const epochId = epochIdFor(runtime.rt.sessionId);
				for (const msg of messages) {
					const raw = toRawTranscriptRow(msg, runtime.rt.sessionId, epochId);
					if (raw) appendRawTranscript(db, raw);
				}
			} catch (e) {
				runtime.logger.warn("db-mirror-append-fail", { error: String(e) });
			}
		}

		// FAST GATE: token-based (tier% of the window), not a static amount.
		if (currentTokens < runtime.effectiveThreshold) {
			runtime.diagCtxFastGate++;
			return;
		}

		const check = autoCompactCheck(currentTokens, runtime.effectiveThreshold); // SERVER-STYLE CONFIRM (local)
		if (!check.shouldCompact) {
			runtime.diagCtxNoCompact++;
			return;
		}

		// Debounce so we don't fire on every context event past threshold.
		const now = Date.now();
		if (now < runtime.debounceUntil) {
			runtime.diagCtxDebounce++;
			return;
		}
		runtime.debounceUntil = now + 2000;

		// Adaptive compression (Fix E): scale compression strength + keepFrom depth
		// with how close we are to the model context limit.
		const pressure = pressureFromPct(pct);
		const ran = runCompact(pi, runtime, config, ctx, messages, {
			compressionPressure: pressure,
		});
		if (ran.skipped) {
			runtime.diagCtxRunSkipped++;
			return;
		}

		// S27 DB-mirror: write checkpoint_epoch with deterministic nonce.
		// This makes the cache key stable across identical compactions.
		if (config.dbMirror) {
			try {
				const db = openStore(runtime.currentStateDir);
				const cpId = ran.result.checkpointId ?? `epoch-${Date.now()}`;
				const epoch: CheckpointEpoch = {
					epochId: epochIdFor(cpId),
					sessionId: runtime.rt.sessionId,
					startedSeq: 0,
					committedSeq: ran.result.compactedFrom,
					checkpointId: cpId,
					cutIndex: ran.result.compactedFrom,
					summaryMessageText: ran.result.summary,
					createdAt: Date.now(),
				};
				writeCheckpointEpoch(db, epoch);
				// S27 Task 6: Fire-and-forget dedup pipeline.
				// Deduplicates raw_transcript rows for the compacted range.
				try {
					const { dedupTranscript } = await import("../src/mirror/dedup.js");
					dedupTranscript(
						db,
						runtime.rt.sessionId,
						0,
						ran.result.compactedFrom,
					);
				} catch (_dedupErr) {
					// Fire-and-forget: dedup failure is non-fatal
				}
			} catch (e) {
				runtime.logger.warn("db-mirror-epoch-fail", { error: String(e) });
			}
		}

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
			const sinceCompact = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
			if (sinceCompact < 10_000 || piCompactWouldNoop(ctx)) return;
			ctx.compact({ customInstructions: undefined }); // race-guarded by lastNativeCompactAt cooldown (ctx.compact returns void → not catchable; the cooldown prevents the call)
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
			});
			if (cut === null) {
				runtime.diagCtxCutNull++;
				runtime.logger.info("live-trim-skip", {
					sessionId: runtime.rt.sessionId,
					compactedFrom: ran.result.compactedFrom,
					viewLen: view.length,
					anchorUserMessages,
				});
				return; // unsafe / below anchor floor — no trim this call
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
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			const recent = messages.slice(cut); // guardrails-allow PREVENT-PI-002: `cut` is the pre-sanitized `compactedFrom` produced by src/boundary.ts computeDropRange, so the preserved run begins on a toolPair-safe index.
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
			return { messages: [summaryAgentMsg, ...recent] };
		} catch {
			runtime.diagCtxThrown++;
			return; // non-fatal: no trim this call; the next context event retries
		}
	});

	// ---- Supply a DURABLE trim to pi's native compaction (Fix B) ----------
	// We run the Trident pipeline to produce a compressed summary, then return
	// it as a CompactionResult. pi writes the summary into a compactionSummary
	// entry AND truncates the on-disk transcript from firstKeptEntryId. This is
	// the durable fix for "tokens grow on read": the trim survives resume, so
	// there is no full-reload + additive recall inflation.
	pi.on(
		"session_before_compact",
		async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
			runtime.resetRuntime(ctx.sessionManager.getSessionId());
			// DIAG (team-run relief): this is the ONLY durable-trim entry point. Log
			// every fire + whether we supplied a compaction (truncates transcript) or
			// fell through to {} (pi runs its own). If this is sparse during a team
			// run, the durable trim is firing too late (only at parent settle).
			const prep = event.preparation;
			runtime.diagBeforeCompactFires++;
			runtime.logger.info("before-compact-entry", {
				sessionId: runtime.rt.sessionId,
				reason: event.reason,
				hasPrep: !!prep,
				msgsToSummarize: prep?.messagesToSummarize?.length ?? 0,
				firstKeptEntryId: prep?.firstKeptEntryId ?? null,
				activeAgents: runtime.activeAgents,
			});
			if (!config.auto) return {}; // let pi run its own native compaction
			try {
				const result = driveNativeCompaction(event, runtime, config);
				if (result && result.compaction.summary?.trim()) {
					runtime.diagBeforeCompactSupplied++;
					runtime.logger.info("native-compact", {
						sessionId: runtime.rt.sessionId,
						firstKeptEntryId: result.compaction.firstKeptEntryId,
						tokensBefore: result.compaction.tokensBefore,
						summaryTokens: result.compaction.estimatedTokensAfter,
					});
					nudgeResume(pi, runtime);
					return { compaction: result.compaction };
				}
				// FIX "compacts but doesn't resume" + "Nothing to compact" regression:
				// when we have nothing to summarize (anchor floor protects everything →
				// messagesToSummarize empty) or our Trident/RAPTOR summary came back
				// EMPTY, pi's OWN compact() throws "Nothing to compact (session too
				// small)" and leaves the session stuck with no resume context. Instead
				// of returning {} (which makes pi run its throwing compact()), supply a
				// fallback compaction from prep.firstKeptEntryId with a minimal resume
				// summary. This ALWAYS injects a compact summary so the session
				// resumes, and never surfaces the "Nothing to compact" error to the user.
				const fb = fallbackCompaction(event);
				if (fb) {
					runtime.diagBeforeCompactSupplied++;
					runtime.logger.info("native-compact-fallback", {
						sessionId: runtime.rt.sessionId,
						firstKeptEntryId: fb.compaction.firstKeptEntryId,
						tokensBefore: fb.compaction.tokensBefore,
						reason: event.reason,
					});
					nudgeResume(pi, runtime);
					return { compaction: fb.compaction };
				}
			} catch (err) {
				runtime.logger.error("native-compact-failed", {
					sessionId: runtime.rt.sessionId,
					error: String(err instanceof Error ? err.message : err),
				});
			}
			// Absolute last resort: let pi run its own (may throw "Nothing to compact").
			return {};
		},
	);

		// COMPACT-DEDUP FIX: track EVERY compaction (native + extension-supplied)
		// so the agent_end durable-trim guard can skip a redundant ctx.compact()
		// when pi just compacted. Without this, agent_end fires ctx.compact()
		// synchronously AFTER pi's native auto-compaction appended a compaction
		// entry but BEFORE our branch read sees it on the next tick — racing
		// into a user-facing "Already compacted" throw. `lastCompactAt` is the
		// race-closing signal: any compaction (manual/threshold/overflow, ours
		// or pi's own) stamps it, and the agent_end guard skips for 10s.
		pi.on("session_compact", async (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
			runtime.rt.lastNativeCompactAt = Date.now();
			runtime.rt.lastCompactAt = Date.now();
			runtime.logger.info("session-compacted", {
				sessionId: runtime.rt.sessionId,
				at: runtime.rt.lastCompactAt,
			});
		});

	/**
	 * Build a minimal fallback compaction so pi never runs its throwing compact().
	 *
	 * Used when our Trident/RAPTOR summary is empty or there is nothing to
	 * summarize (the anchor floor protects every message). We still record a
	 * resume summary + truncate from prep.firstKeptEntryId so the session always
	 * gets a compact summary and resumes. Returns undefined only if pi handed us
	 * no preparation cut point at all.
	 */
	function fallbackCompaction(
		event: SessionBeforeCompactEvent,
	): NativeCompactionResult | undefined {
		const prep = event.preparation;
		if (!prep?.firstKeptEntryId) return undefined;
		// When messagesToSummarize is empty the anchor floor protects everything,
		// so firstKeptEntryId == current first entry and the trim is a no-op — but
		// we still record a resume summary so the session has context after compaction.
		const tokensBefore = prep.tokensBefore ?? 0;
		const summary =
			`[mega-compact] context compacted at ${tokensBefore.toLocaleString()} tokens ` +
			`(anchor floor active). Continue from the most recent messages above.`;
		return {
			compaction: {
				summary,
				firstKeptEntryId: prep.firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter: estimateBlockTokens(summary),
			},
		};
	}

	/**
	 * Debounced resume-nudge: restart the agent loop after a compaction (which
	 * may have stopped it). Idempotent — one nudge per 30s, never blocks.
	 */
	function nudgeResume(pi: ExtensionAPI, runtime: MegaRuntime): void {
		try {
			const now = Date.now();
			if (now >= runtime.resumeNudgeUntil) {
				runtime.resumeNudgeUntil = now + 30_000;
				pi.sendUserMessage(
					"[mega-compact] continue from the compacted context above.",
				);
			}
		} catch {
			/* non-fatal: a failed nudge never blocks */
		}
	}
}
