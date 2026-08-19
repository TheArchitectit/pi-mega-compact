/**
 * context-handler/liveTrim.ts — S16 live-trim view reconstruction.
 *
 * Extracted from context-handler.ts (delegate-shell split). Collapses the
 * compacted region to a summary + recent anchor for THIS LLM call only (pi
 * keeps the real transcript; the trim is non-destructive). Computes the cut on
 * the engine view (pure, tested) then slices the ORIGINAL pi AgentMessage[]
 * from that index (lossless alignment) and prepends a user-role summary. A
 * build failure or unsafe cut returns nothing (no trim this call — the next
 * context event retries). Includes the FIX 2 token-budget cap so a single
 * oversized tool output can't sail past the model window.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EngineMessage } from "../../../src/types.js";
import { estimateBlockTokens } from "../../../src/tokens.js";
import { computeLiveTrimCut, liveTrimSummaryMessage } from "../../mega-trim.js";
import { applyTailCap } from "./headroom.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import type { TailResultFn } from "./gateCheck.js";

/** Shape of the compact result consumed by the live-trim cut computation. */
interface CompactResult {
	checkpointId?: string;
	compactedFrom: number;
	summary: string;
}

/**
 * Reconstruct the live-trim window (summary + recent anchor) for this LLM
 * call. Returns the tailed view, or undefined when no trim is safe this call.
 */
export function buildLiveTrimView(
	runtime: MegaRuntime,
	config: MegaConfig,
	ctx: ExtensionContext,
	opts: {
		messages: readonly AgentMessage[];
		view: EngineMessage[];
		pct: number | null | undefined;
		currentTokens: number;
		usageTokens: number | null | undefined;
		pressure: number;
		ran: { result: CompactResult };
		perModelThreshold: { safetyMarginPct: number; firePointPct: number };
		tailResult: TailResultFn;
	},
): { messages: AgentMessage[] } | undefined {
	const {
		messages,
		view,
		pct,
		currentTokens,
		usageTokens,
		pressure,
		ran,
		perModelThreshold,
		tailResult,
	} = opts;

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
		// v0.21.9: the reserve + front-drop now lives in headroom.ts (single
		// source shared with the gate's pre-fire headroom check and the D.2/D.3
		// replay paths): (a) percent-based reserve — plausible declared maxTokens
		// wins, else clamp(MEGACOMPACT_OUTPUT_RESERVE_PCT, 10–95%) × window — so
		// the math is identical at any window size and a sentinel maxTokens
		// (1e9/1e38) can no longer drive the budget negative and silently
		// disable the cap; (b) budget floor (max(1, …)) so the cap stays active
		// on every window; (c) pair-safe front-drop — the preserved tail never
		// begins on an orphaned toolResult (PREVENT-PI-002).
		const ctxWindow = runtime.lastCtxWindow;
		// Reuse the per-model threshold resolved at the gate (single lookup).
		const modelThreshold = perModelThreshold;
		const { recent, dropped } = applyTailCap({
			recentRaw,
			summaryTokens: estimateBlockTokens(summaryMsg.text),
			ctxWindow,
			maxOutputTokens: runtime.currentModel?.maxTokens ?? 0,
			outputReservePct: config.outputReservePct,
			safetyMarginPct: modelThreshold.safetyMarginPct,
		});
		if (dropped > 0) {
			runtime.logger.warn("live-trim-tail-cap", {
				sessionId: runtime.rt.sessionId,
				dropped,
				safetyMarginPct: modelThreshold.safetyMarginPct,
				ctxWindow,
			});
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
			// v0.21.9: the D.2/D.3 replay paths re-cap the replayed tail against
			// the CURRENT window (a model switch can change it mid-epoch). The
			// margin % used at fire time is stored alongside so the replay uses
			// the same reserve math as the fire that built the view.
			safetyMarginPct: modelThreshold.safetyMarginPct,
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
			ctxTokens: usageTokens,
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
}
