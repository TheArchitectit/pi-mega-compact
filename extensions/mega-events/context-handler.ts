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
	type CheckpointEpoch,
	type RawTranscriptRow,
} from "../../src/store/sqlite.js";
import { epochIdFor } from "../../src/mirror/epoch.js";
import { autoCompactCheck } from "../../src/compact.js";
import { estimateSessionTokens } from "../../src/tokens.js";
import { type MegaRuntime } from "../mega-runtime.js";
import { runCompact, piCompactWouldNoop } from "../mega-pipeline.js";
import { computeLiveTrimCut, liveTrimSummaryMessage } from "../mega-trim.js";
import {
	pressureFromPct,
	pressureRatio,
	type MegaConfig,
} from "../mega-config.js";
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
		if (!config.auto) return;
		const usage = ctx.getContextUsage();
		const pct = usage?.percent;
		// Always track context for the dashboard, even if we return early below.
		runtime.lastCtxTokens = usage?.tokens ?? null;
		runtime.lastCtxPercent = pct ?? null;
		runtime.lastCtxWindow = usage?.contextWindow ?? 0;
		runtime.snapshot(ctx);

		const messages = event.messages;
		const view = runtime.engineView(messages);
		const currentTokens =
			usage?.tokens ??
			estimateSessionTokens(view) ??
			Math.round(((pct ?? 0) / 100) * (usage?.contextWindow ?? 0));

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

		// Adaptive compression (Fix E): scale compression strength + keepFrom depth
		// with how close we are to the model context limit. Null-safe: when the
		// token-fallback path ran (pct unavailable) use the token-basis pressure
		// (the same basis the runtime `pressure` getter uses for custom/no-window).
		const pressure = pct != null ? pressureFromPct(pct) : pressureRatio(currentTokens, runtime.effectiveThreshold);
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
}
