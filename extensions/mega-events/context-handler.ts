/**
 * mega-events/context-handler.ts — the context event handler (auto-trigger).
 *
 * Handles the live-trim compaction pipeline: DB-mirror append, fast-gate
 * threshold check, pipeline invocation, checkpoint epoch write, dedup, and
 * the live-trim message reconstruction that feeds pi's transformContext.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ContextEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	openStore,
	writeCheckpointEpoch,
	type CheckpointEpoch,
} from "../../src/store/sqlite.js";
import { epochIdFor } from "../../src/mirror/epoch.js";
import { autoCompactCheck } from "../../src/compact.js";
import { estimateSessionTokens } from "../../src/tokens.js";
import type { MegaRuntime } from "../mega-runtime.js";
import { runCompact, piCompactWouldNoop } from "../mega-pipeline.js";
import { stampTurnsEpochFor } from "../mega-turn-store.js";
import { TurnsConfig } from "../../src/config/turns.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import {
	buildTopicModel,
	createTopicStore,
	bumpWikiCompactCounter,
} from "../../src/topics/index.js";
import { TrigramEmbedder } from "../../src/embedder.js";
import type { EmbeddedChunk } from "../../src/topics/types.js";
import { computeLiveTrimCut, liveTrimSummaryMessage } from "../mega-trim.js";
import {
	pressureFromPct,
	pressureRatio,
	type MegaConfig,
} from "../mega-config.js";
import { appendMirrorMessages } from "./mirror-append.js";
import { stagedForTail, withRecallTail } from "./recall-tail.js";
import { buildSeparatedPrompt, buildCacheOptimizedPrompt } from "./separated-prompt.js";

/** Best-effort text extraction from an AgentMessage for analytics/logging.
 *  AgentMessage is a discriminated union; .content exists only on some
 *  variants (user/assistant/toolResult/custom). Narrow by role, never assume. */
function messageContentText(m: AgentMessage): string {
	const c = (m as { content?: unknown }).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
			.join(" ");
	}
	return "";
}

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
		// normal return. The F3 mirror append (above the gates) runs on the
		// REAL transcript before any view is built, so the injected tail never
		// reaches raw_transcript (PREVENT-PI: append-only, view-only).
		const tailResult = (msgs?: readonly AgentMessage[]) => {
			const base = msgs ?? messages;
			if (!stagedForTail(runtime, config) && !config.messageSeparation && !config.cacheStriping) return undefined;
			let result: AgentMessage[] = stagedForTail(runtime, config)
				? withRecallTail(base, runtime, config)
				: (base as AgentMessage[]);
			if (config.cacheStriping) {
				result = buildCacheOptimizedPrompt(result);
			} else if (config.messageSeparation) {
				result = buildSeparatedPrompt(result);
			}
			// P2.5: log prefix stability (fire-and-forget, non-fatal).
			// tailResult is sync, so use .then().catch() on the dynamic import.
			if (result.length > 1) {
				import("../../src/cache-stripe-impl.js").then(({ computeStabilityScore }) => {
					const stableScore = computeStabilityScore(
						{ content: messageContentText(result[0] ?? result[0]), chunkId: "prefix", accessCount: 0, lastAccessedAt: 0 },
						result.slice(0, 2).map((m) => ({ content: messageContentText(m), chunkId: "prefix", accessCount: 0, lastAccessedAt: 0 })),
					);
					runtime.logger.info("prefix_stability", {
						stableScore: Number.isFinite(stableScore) ? stableScore : 0,
						prefixMessages: result.length,
						separation: config.messageSeparation ? "v2" : "off",
						striping: config.cacheStriping ? "v3" : "off",
					});
				}).catch(() => {
					// Non-fatal: stability logging is best-effort.
				});
			}
			return { messages: result };
		};
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

		// S29 FAST GATE: drive the auto-trigger off the context % (the number the
		// menu bar shows), NOT the token count — the model under-reports tokens,
		// so a token-only gate misses the overshoot that causes max-output-tokens
		// truncation. The fire point is the tier's percent threshold (tierPct)
		// unless overridden by MEGACOMPACT_AUTO_PCT_TRIGGER. `custom` (absolute
		// MEGACOMPACT_THRESHOLD_TOKENS, tierPct null) is an explicit opt-out of
		// percent scaling — it keeps the token gate. When pct is unavailable
		// (window unknown / a model that doesn't report percent) a tiered config
		// falls back to the token gate (S27 boot-fallback guarantee) instead of
		// skipping compaction — a percent-only gate would regress that.
		let gatePassed = false;
		if (config.tierPct != null && pct != null) {
			const firePct = config.autoPctTrigger ?? config.tierPct;
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
				const replayView = [{ ...runtime.trimCache.summaryAgentMsg }, ...recent];
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
				const recent = messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002
				runtime.diagLiveTrimFires++;
				runtime.diagLiveTrimReplays++;
				runtime.snapshot(ctx);
				const skipView = [{ ...runtime.trimCache.summaryAgentMsg }, ...recent];
				return tailResult(skipView) ?? { messages: skipView };
			}
			return tailResult() ?? undefined;
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
				// S50B: link this session's turns to the epoch that just compacted
				// them (compression-by-conversation-epoch metrics). Isolated-store
				// only; best-effort + non-fatal.
				try {
					stampTurnsEpochFor(
						config,
						runtime.rt.sessionId,
						epoch.epochId,
						runtime.currentStateDir,
					);
				} catch {
					/* non-fatal: epoch stamping never breaks compaction */
				}
				// S51B: auto-categorizing wiki rebuild — every Nth compaction, derived
				// from real context_chunks embeddings. Isolated-store only, gated on
				// AUTO_WIKI_ENABLED; best-effort + non-fatal (never breaks compaction).
				try {
					if (config.autoWikiEnabled && config.turnsDbEnabled) {
						const every = Math.max(
							1,
							TurnsConfig.WIKI_REBUILD_EVERY_N_COMPACTS,
						);
						const tdb = openTurnStore(runtime.currentStateDir);
						const n = bumpWikiCompactCounter(tdb);
						if (n % every === 0) {
							const model = buildTopicModel(db, {
								kRange: [TurnsConfig.WIKI_K_MIN, TurnsConfig.WIKI_K_MAX],
								labelTopTerms: TurnsConfig.WIKI_LABEL_TOP_TERMS,
								restarts: 5,
								seed: 0x9e3779b9,
							});
							createTopicStore(runtime.currentStateDir).replaceTopicModel(
								model,
							);
							runtime.logger.info("wiki_rebuild", {
								clusterCount: model.k,
								totalChunks: model.totalChunks,
								method: "kmeans+tfidf",
								criterion: model.criterion,
								silhouetteScore: model.silhouetteScore,
								uncalibrated: false,
							});
						}
					}
				} catch (wikiErr) {
					runtime.logger.warn("wiki_rebuild_failed", {
						error: String(wikiErr),
					});
				}

				// D1: seed the topic model from raw_transcript when context_chunks is
				// thin (pre-compaction). Gated on WIKI_SEED_FROM_TURNS; non-fatal.
				// Seeds buildTopicModel with on-the-fly trigram embeddings from
				// recent raw_transcript rows for the current session.
				try {
					if (
						config.autoWikiEnabled &&
						config.turnsDbEnabled &&
						TurnsConfig.WIKI_SEED_FROM_TURNS
					) {
						const floor = 50;
						const countRow = db
							.prepare(
								`SELECT COUNT(*) AS cnt FROM context_chunks WHERE session_id = ?`,
							)
							.get(runtime.rt.sessionId) as { cnt: number } | undefined;
						const chunkCount = countRow?.cnt ?? 0;
						if (chunkCount < floor) {
							const transcriptRows = db
								.prepare(
									`SELECT DISTINCT content_bytes
			       FROM raw_transcript
			       WHERE session_id = ?
			         AND length(content_bytes) > 10
			       ORDER BY seq ASC
			       LIMIT 200`,
								)
								.all(runtime.rt.sessionId) as Array<{
								content_bytes: string;
							}>;
							if (transcriptRows.length > 0) {
								const embedder = new TrigramEmbedder();
								const seedChunks: EmbeddedChunk[] = [];
								for (let i = 0; i < transcriptRows.length; i++) {
									const text = transcriptRows[i].content_bytes.trim();
									if (text.length === 0) continue;
									const vec = embedder.embed(text);
									seedChunks.push({
										chunkId: `seed_transcript_${i}`,
										sessionId: runtime.rt.sessionId,
										vec,
										text,
									});
								}
								if (seedChunks.length > 0) {
									const model = buildTopicModel(
										db,
										{
											kRange: [
												TurnsConfig.WIKI_K_MIN,
												TurnsConfig.WIKI_K_MAX,
											],
											labelTopTerms:
												TurnsConfig.WIKI_LABEL_TOP_TERMS,
											restarts: 5,
											seed: 0x9e3779b9,
										},
										seedChunks,
									);
									createTopicStore(
										runtime.currentStateDir,
									).replaceTopicModel(model);
									runtime.logger.info("wiki_seed", {
										clusterCount: model.k,
										sourceChunks: seedChunks.length,
										totalChunks: model.totalChunks,
										method: "kmeans+tfidf",
									});
								}
							}
						}
					}
				} catch (seedErr) {
					runtime.logger.warn("wiki_seed_failed", {
						error: String(seedErr),
					});
				}
				// S27 Task 6: Fire-and-forget dedup pipeline.
				// Deduplicates raw_transcript rows for the compacted range.
				try {
					const { dedupTranscript } = await import("../../src/mirror/dedup.js");
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
			});
			if (cut === null) {
				runtime.diagCtxCutNull++;
				runtime.logger.info("live-trim-skip", {
					sessionId: runtime.rt.sessionId,
					compactedFrom: ran.result.compactedFrom,
					viewLen: view.length,
					anchorUserMessages,
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
			const recent = messages.slice(cut); // guardrails-allow PREVENT-PI-002: `cut` is the pre-sanitized `compactedFrom` produced by src/boundary.ts computeDropRange, so the preserved run begins on a toolPair-safe index.
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
			return tailResult([summaryAgentMsg, ...recent]) ?? { messages: [summaryAgentMsg, ...recent] };
		} catch {
			runtime.diagCtxThrown++;
			return tailResult() ?? undefined; // non-fatal: no trim this call; the next context event retries
		}
	});
}
