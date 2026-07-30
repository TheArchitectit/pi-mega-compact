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
	appendRawTranscript,
	writeCheckpointEpoch,
	recordPerfSample,
	type CheckpointEpoch,
	type RawTranscriptRow,
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
import { computeLiveTrimCut, liveTrimSummaryMessage } from "../mega-trim.js";
import {
	pressureFromPct,
	pressureRatio,
	type MegaConfig,
} from "../mega-config.js";
import { computeContentDigest } from "../../src/dedup/digest.js";
import {
	diffPrefixChain,
	hashPrefixMessage,
	isPrefixTelemetryEnabled,
} from "../../src/prompt/prefix-telemetry.js";

/**
 * Recursively canonicalize a value for deterministic JSON serialization:
 * - Objects: keys sorted alphabetically, values recursively canonicalized
 * - Arrays: elements recursively canonicalized (array ORDER is preserved)
 * - Primitives: returned as-is
 *
 * F5 fix: shallow-sorted JSON.stringify(content, Object.keys(content).sort())
 * omitted nested keys not in the top-level keys array and only sorted one level.
 * This recursively sorts every object at every depth so semantically-equal
 * differently-ordered content hashes identically.
 */
function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	// Plain object: sort keys, recursively canonicalize values.
	const sorted = Object.keys(value as Record<string, unknown>).sort();
	const out: Record<string, unknown> = {};
	for (const k of sorted) {
		out[k] = canonicalize((value as Record<string, unknown>)[k]);
	}
	return out;
}

/**
 * Convert a pi AgentMessage to a RawTranscriptRow for the DB mirror.
 * content_bytes is canonical JSON (sorted keys, recursive) for deterministic
 * storage; contentHash is the canonical digest (normalize + hash) that matches
 * what dedupTranscript computes so the two pipelines use the same linkage key.
 *
 * F4 fix: the hash key MUST match on both sides of the append/dedup split.
 * Using computeContentDigest here (normalize → hash) ensures content_ref set
 * by dedupTranscript always resolves to an existing dedup_mirror row even for
 * whitespace/case-variant content. F5 fix: recursive canonicalize replaces the
 * broken shallow-sorted JSON.stringify replacer.
 */
function toRawTranscriptRow(
	msg: AgentMessage,
	sessionId: string,
	epochId: string,
	currentTurn?: number,
): RawTranscriptRow | null {
	// Narrow to Message union (has content + timestamp).
	const m = msg as {
		role?: string;
		content?: unknown;
		timestamp?: number;
		toolName?: string;
	};
	const content = m.content;
	if (content == null || content === "") return null;
	// Canonical bytes: string content → normalize for consistent byte content;
	// object content → recursive canonicalize then JSON (no replacer).
	const contentBytes =
		typeof content === "string"
			? content // F5: strings are primitives; their byte content is fixed
			: JSON.stringify(canonicalize(content));
	// F4 fix: use the same digest as dedupTranscript so contentHash is consistent
	// on both sides of the append/dedup split. computeContentDigest normalizes
	// (strip ANSI, NFC, case-fold, collapse whitespace) then hashes → the same
	// key is stored in raw_transcript.content_hash AND used as the dedup link.
	const { contentHash } = computeContentDigest(contentBytes);
	return {
		contentHash,
		sessionId,
		seq: 0, // assigned by appendRawTranscript (COALESCE(MAX(seq),0)+1)
		role: m.role ?? "unknown",
		contentBytes,
		toolName: m.toolName ?? null,
		messageTimestamp: m.timestamp ?? null,
		checkpointEpoch: epochId,
		// S50: label the row with the turn that produced it (per-turn dedup /
		// compression-by-turn metrics). Null when the writer omits it (back-compat).
		turnIndex: currentTurn ?? null,
	};
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

		// S54 prefix-break telemetry: hash the outgoing message chain
		// (role + canonical content bytes, FNV-1a) and diff it against the
		// previous context event's chain. A first-divergence index below the
		// previous length = the provider's cache prefix broke this call; the
		// cause classifier attributes it (epoch roll / recall prepend / tool
		// insertion / other) and one cache_prefix_break sample is recorded.
		// Flag MEGACOMPACT_PREFIX_TELEMETRY=0 removes this whole block's work
		// (byte-identical behavior). Runs BEFORE the auto gate so manual-only
		// sessions get telemetry too. Non-fatal: telemetry never blocks a call.
		if (isPrefixTelemetryEnabled()) {
			try {
				const epochId = epochIdFor(runtime.rt.sessionId);
				const chain = new Array<string>(messages.length);
				const toolFlags = new Array<boolean>(messages.length);
				for (let i = 0; i < messages.length; i++) {
					const m = messages[i] as {
						role?: string;
						content?: unknown;
						toolName?: string;
					};
					const c = m.content;
					const bytes =
						c == null
							? ""
							: typeof c === "string"
								? c
								: JSON.stringify(canonicalize(c));
					chain[i] = hashPrefixMessage(m.role ?? "unknown", bytes);
					toolFlags[i] =
						m.role === "toolResult" ||
						m.toolName != null ||
						(Array.isArray(c) &&
							c.some(
								(b) =>
									(b as { type?: string } | null)?.type === "toolCall" ||
									(b as { type?: string } | null)?.type === "tool_result",
							));
				}
				const res = diffPrefixChain(runtime.lastPrefixChain, chain, {
					epochChanged:
						runtime.lastPrefixEpochId != null &&
						runtime.lastPrefixEpochId !== epochId,
					recallInjected:
						runtime.lastRecallInjectAt != null &&
						Date.now() - runtime.lastRecallInjectAt < 30_000,
					isToolMessage: (i) => toolFlags[i] ?? false,
				});
				if (res.broke) {
					recordPerfSample(
						runtime.currentStateDir,
						"cache_prefix_break",
						res.breakIndex,
						{
							cause: res.cause,
							epochId,
							prevLen: res.prevLen,
							currLen: res.currLen,
							turnIndex: runtime.currentTurn,
						},
					);
					runtime.logger.info("cache-prefix-break", {
						cause: res.cause,
						breakIndex: res.breakIndex,
						prevLen: res.prevLen,
						currLen: res.currLen,
					});
				}
				runtime.lastPrefixChain = chain;
				runtime.lastPrefixEpochId = epochId;
			} catch {
				/* non-fatal: prefix telemetry must never affect the prompt path */
			}
		}
		if (!config.auto) return;

		const view = viewForFallback ?? runtime.engineView(messages);

		// S27 DB-mirror: append ALL incoming messages to raw_transcript.
		// Runs BEFORE fast-gate so every message is captured, even if we
		// don't compact this turn. Append is idempotent (content_hash PK).
		if (config.dbMirror) {
			try {
				const db = openStore(runtime.currentStateDir);
				const epochId = epochIdFor(runtime.rt.sessionId);
				for (const msg of messages) {
					const raw = toRawTranscriptRow(msg, runtime.rt.sessionId, epochId, runtime.currentTurn);
					if (raw) appendRawTranscript(db, raw);
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
				return;
			}
			const check = autoCompactCheck(currentTokens, runtime.effectiveThreshold); // SERVER-STYLE CONFIRM (local)
			if (!check.shouldCompact) {
				runtime.diagCtxNoCompact++;
				return;
			}
			gatePassed = true;
		}
		if (!gatePassed) {
			runtime.diagCtxFastGate++;
			return;
		}

		// Debounce so we don't fire on every context event past threshold.
		const now = Date.now();
		if (now < runtime.debounceUntil) {
			runtime.diagCtxDebounce++;
			return;
		}
		runtime.debounceUntil = now + 2000;

		// v0.8.6 cache-stability: replay the cached trim view when still in the
		// same compaction epoch AND context hasn't grown enough to warrant a
		// re-compact. This stabilizes the provider KV-cache prefix (the summary +
		// cut are reused verbatim) instead of regenerating a fresh summary +
		// sentinel every fire, which invalidated the prefix on every other turn
		// (the alternating cache-miss regression). Re-compact only when context
		// grew >=10% of the window (percent basis) or >=50% of the effective
		// threshold (token basis, when percent is unavailable). The cached `cut`
		// is only valid while the transcript grows within the epoch — it is
		// cleared on session_compact (durable truncation) + resetRuntime, so we
		// never replay a stale cut into a truncated transcript (PREVENT-PI-001/002).
		const RECOMPACT_PCT_DELTA = 10;
		if (
			runtime.trimCache &&
			runtime.trimCache.checkpointId === runtime.rt.lastCheckpointId &&
			runtime.trimCache.cut <= messages.length
		) {
			const grewEnough =
				pct != null && runtime.trimCache.ctxPct != null
					? pct - runtime.trimCache.ctxPct >= RECOMPACT_PCT_DELTA
					: currentTokens - (runtime.trimCache.ctxTokens ?? 0) >=
						runtime.effectiveThreshold * 0.5;
			if (!grewEnough) {
				const recent = messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002: cached `cut` was sanitized once by computeLiveTrimCut (src/boundary.ts) and replayed verbatim; the transcript only grows within an epoch (cache is cleared on durable truncation), so the preserved run still starts on a toolPair-safe index.
				runtime.diagLiveTrimFires++; // trim view returned this call (replay counts as a fire)
				runtime.diagLiveTrimReplays++;
				runtime.snapshot(ctx);
				// v0.8.7: shallow-copy the cached summary so pi's transformContext can't
				// mutate the shared reference across replays (audit P3).
				return {
					messages: [{ ...runtime.trimCache.summaryAgentMsg }, ...recent],
				};
			}
			// else: context grew enough → fall through to re-compact (cache is stale)
		}

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
				// S50B: link this session's turns to the epoch that just compacted
				// them (compression-by-conversation-epoch metrics). Isolated-store
				// only; best-effort + non-fatal.
				try {
					stampTurnsEpochFor(config, runtime.rt.sessionId, epoch.epochId, runtime.currentStateDir);
				} catch {
					/* non-fatal: epoch stamping never breaks compaction */
				}
				// S51B: auto-categorizing wiki rebuild — every Nth compaction, derived
				// from real context_chunks embeddings. Isolated-store only, gated on
				// AUTO_WIKI_ENABLED; best-effort + non-fatal (never breaks compaction).
				try {
					if (config.autoWikiEnabled && config.turnsDbEnabled) {
						const every = Math.max(1, TurnsConfig.WIKI_REBUILD_EVERY_N_COMPACTS);
						const tdb = openTurnStore(runtime.currentStateDir);
						const n = bumpWikiCompactCounter(tdb);
						if (n % every === 0) {
							const model = buildTopicModel(db, {
								kRange: [TurnsConfig.WIKI_K_MIN, TurnsConfig.WIKI_K_MAX],
								labelTopTerms: TurnsConfig.WIKI_LABEL_TOP_TERMS,
								restarts: 5,
								seed: 0x9e3779b9,
							});
							createTopicStore(runtime.currentStateDir).replaceTopicModel(model);
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
					runtime.logger.warn("wiki_rebuild_failed", { error: String(wikiErr) });
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
				// RT2 (audit): track the timer so reset/dispose can cancel it.
				if (runtime.pendingDurableTrimTimer)
					clearTimeout(runtime.pendingDurableTrimTimer);
				runtime.pendingDurableTrimTimer = setTimeout(() => {
					runtime.pendingDurableTrimTimer = null;
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
			return { messages: [summaryAgentMsg, ...recent] };
		} catch {
			runtime.diagCtxThrown++;
			return; // non-fatal: no trim this call; the next context event retries
		}
	});
}
