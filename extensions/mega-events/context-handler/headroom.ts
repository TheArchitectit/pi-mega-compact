/**
 * context-handler/headroom.ts — output-headroom reserve math + pair-safe tail cap.
 *
 * v0.21.9. Single source of truth for the output reserve used by BOTH the
 * gate's pre-fire overflow check (gateCheck.ts) and the live-trim tail cap
 * (liveTrim.ts + the D.2/D.3 replay paths). The pre-v0.21.9 code computed the
 * reserve inline in liveTrim only and never in the gate — the two halves could
 * drift, and the gate had no output awareness at all.
 *
 * PERCENT-BASED BY DESIGN (per the LTS invariant): every quantity is expressed
 * as a fraction of the MODEL'S OWN context window, so the math is identical at
 * any window size — 32k, 64k, 200k, 1M, 5M. The reserve is the model's
 * declared max output tokens when plausible, else a clamped fraction of the
 * window (MEGACOMPACT_OUTPUT_RESERVE_PCT, default 30%, clamped 10–95%).
 *
 * Pure functions, no runtime dependency — trivially unit-testable headlessly.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateBlockTokens } from "../../../src/tokens.js";
import { messageContentText } from "./messageText.js";

/**
 * Full-surface AgentMessage token estimate for BUDGET arithmetic (tail cap).
 *
 * convertToLlm (pi dist/core/messages.js) ships assistant/toolResult messages
 * VERBATIM — every content block goes over the wire: text, thinking, toolCall
 * (name + full `arguments` JSON), toolResult output, role wrappers. The text
 * extractor (messageContentText) is lossy-on-purpose for analytics, and using
 * it here made a GLM-4.7-style assistant message with ~11.6k bytes of toolCall
 * arguments register as ~77 tokens — a 30k-token tail passed an 11.9k budget,
 * the model overflowed, and pi's one-shot compact-and-retry failed
 * ("Context overflow recovery failed", 2026-08-20 incident).
 *
 * Counts every byte the provider actually receives. Still a heuristic (len/4
 * + 1 per block, like estimateBlockTokens) — just no longer lossy. Never
 * throws: unknown block shapes fall back to their JSON serialization length,
 * and a non-array/string content is counted as its serialization.
 */
export function estimateAgentMessageBudgetTokens(m: AgentMessage): number {
	try {
		const c = (m as { content?: unknown }).content;
		let bytes = 0;
		if (typeof c === "string") {
			bytes += c.length;
		} else if (Array.isArray(c)) {
			for (const b of c) {
				if (b == null || typeof b !== "object") continue;
				const o = b as Record<string, unknown>;
				if (typeof o.text === "string") bytes += o.text.length;
				if (typeof o.thinking === "string") bytes += o.thinking.length;
				if (typeof o.name === "string") bytes += o.name.length;
				if (o.arguments != null) bytes += JSON.stringify(o.arguments).length;
				if (typeof o.output === "string") bytes += o.output.length;
				// Per-block envelope overhead (role/type markers), matching the
				// len/4+1 block accounting in estimateBlockTokens.
				bytes += 4;
			}
		} else if (c != null) {
			bytes += JSON.stringify(c).length;
		}
		return estimateBlockTokens(" ".repeat(Math.max(0, bytes)));
	} catch {
		// non-fatal: fall back to the legacy text-only estimate rather than
		// disable the cap on a pathological message.
		return estimateBlockTokens(messageContentText(m));
	}
}

/**
 * The model's declared maxTokens is only trusted as the output budget when it
 * is plausible. models.json carries sentinel junk for some entries (1e9,
 * 1e38, "unlimited"), and some providers report 0/absent. A declared budget
 * above this FRACTION of the window is implausible — fall back to the
 * configured fraction so a 200k/1e9 model doesn't compute a negative budget
 * and silently disable the cap (the pre-v0.21.9 bug). Percent-based: holds at
 * every window size.
 *
 * WHY 0.95 AND NOT LOWER: vLLM-style backends reject a request when
 * `input + max_tokens > context window` — they reserve the model's FULL
 * declared maxTokens, not a fraction of it. The user's own GLM-4.7 entry is
 * 32000/20000 (62.5%); a 0.6 cutoff rejected that REAL config as
 * "implausible" and fell back to a 30% reserve (9600) while the backend
 * reserved the full 20000 — the gate would keep firing late and the
 * post-compact tail would still overflow (2026-08-19 incident, attempt #6).
 * A declared budget is plausible up to just below the WHOLE window; anything
 * at/above the window (or the 1e9/1e38 sentinels) is junk.
 */
export const MAX_OUTPUT_PLAUSIBLE_FRACTION = 0.95;

/** Bounds for the fallback reserve fraction (MEGACOMPACT_OUTPUT_RESERVE_PCT). */
export const OUTPUT_RESERVE_PCT_MIN = 0.1;
export const OUTPUT_RESERVE_PCT_MAX = 0.95;

/**
 * Resolve the output reserve (tokens) for a model window.
 *
 *  - window <= 0 (unknown) → { reserveTokens: 0, fallbackUsed: false }; every
 *    consumer is guarded on window > 0 and defers (never guesses a window).
 *  - maxTokens plausible (0 < maxTokens <= 95% of the window) → maxTokens —
 *    vLLM-style backends reserve the FULL declared maxTokens, so the reserve
 *    must equal it, not a fraction of it.
 *  - otherwise → clamp(outputReservePct, 0.1, 0.95) × window.
 *
 * `outputReservePct` is config.outputReservePct (already env-clamped at load,
 * re-clamped here for defense against direct callers).
 */
export function resolveOutputReserve(
	ctxWindow: number,
	maxTokens: number,
	outputReservePct: number,
): { reserveTokens: number; fallbackUsed: boolean } {
	if (!Number.isFinite(ctxWindow) || ctxWindow <= 0) {
		return { reserveTokens: 0, fallbackUsed: false };
	}
	const plausible =
		Number.isFinite(maxTokens) &&
		maxTokens > 0 &&
		maxTokens <= ctxWindow * MAX_OUTPUT_PLAUSIBLE_FRACTION;
	if (plausible) return { reserveTokens: Math.round(maxTokens), fallbackUsed: false };
	const pct = Math.min(
		OUTPUT_RESERVE_PCT_MAX,
		Math.max(OUTPUT_RESERVE_PCT_MIN, Number.isFinite(outputReservePct) ? outputReservePct : 0.3),
	);
	return { reserveTokens: Math.ceil(ctxWindow * pct), fallbackUsed: true };
}

/**
 * Pair-safe front-drop for the live-trim tail cap. Drops OLDEST messages from
 * the front of `recentRaw` until the remaining tail fits
 * `ctxWindow − outputReserve − safetyMargin − summaryTokens`, then advances
 * the start index past any leading toolResult messages so the preserved tail
 * never begins on an orphaned toolResult (PREVENT-PI-002: a toolCall/toolResult
 * pair must not be split). Never returns an empty tail — the final message is
 * always kept so the agent can respond.
 *
 * v0.21.9 hardenings over the pre-v0.21.9 inline cap in liveTrim.ts:
 *  1. BUDGET FLOOR — when the reserve exceeds the window (implausible maxTokens
 *     made budget <= 0) the old block silently skipped the cap entirely and an
 *     oversized tail sailed past the window. Now the reserve is clamped (via
 *     resolveOutputReserve) to a fraction of the window, so a floor budget
 *     always exists. If even ONE message exceeds the floor budget we keep only
 *     the final message — the agent's last turn is the one thing the model
 *     must always see.
 *  2. TOOL-PAIR SAFETY — the old front-drop could land between a toolCall and
 *     its toolResult, splitting the pair.
 *
 * Pure: returns { recent, dropped } without touching the input array.
 */
export function applyTailCap(opts: {
	recentRaw: readonly AgentMessage[];
	summaryTokens: number;
	ctxWindow: number;
	maxOutputTokens: number;
	outputReservePct: number;
	safetyMarginPct: number;
	/**
	 * Optional token-count override for the tail messages. When present, the
	 * token sum is counted from this array (index-aligned with `recentRaw`);
	 * otherwise each message's tokens are estimated from its text content.
	 */
	messageTokens?: readonly number[];
}): { recent: AgentMessage[]; dropped: number } {
	const { recentRaw, summaryTokens, ctxWindow, outputReservePct } = opts;
	if (ctxWindow <= 0 || recentRaw.length <= 1) {
		return { recent: [...recentRaw], dropped: 0 };
	}
	const msgTokens =
		opts.messageTokens && opts.messageTokens.length === recentRaw.length
			? opts.messageTokens
			: null;
	const { reserveTokens } = resolveOutputReserve(
		ctxWindow,
		opts.maxOutputTokens,
		outputReservePct,
	);
	const safetyMargin = Math.ceil(
		ctxWindow * (Math.max(0, opts.safetyMarginPct) / 100),
	);
	// Budget floor: never negative. An implausible reserve (clamped above to
	// <= 95% of the window) plus margin + summary can still exceed the window
	// on tiny summaries-free edges; the floor keeps the cap alive with a small
	// positive budget instead of disabling it (pre-v0.21.9 behavior).
	const budget = Math.max(
		1,
		ctxWindow - reserveTokens - safetyMargin - Math.max(0, summaryTokens),
	);
	let start = 0;
	let tailTokens = 0;
	for (let i = recentRaw.length - 1; i >= 0; i--) {
		tailTokens +=
			msgTokens != null
				? Math.max(0, msgTokens[i])
				: estimateAgentMessageBudgetTokens(recentRaw[i]);
		if (tailTokens > budget) {
			// Keep from i+1 onward; never drop below the FINAL message.
			start = Math.min(i + 1, recentRaw.length - 1);
			break;
		}
	}
	// PREVENT-PI-002: never begin the preserved tail on an orphaned toolResult —
	// its toolCall was dropped by the front-cut above. Advance past consecutive
	// toolResults; the pair stays intact or drops whole.
	while (
		start < recentRaw.length - 1 &&
		(recentRaw[start] as { role?: string }).role === "toolResult"
	) {
		start++;
	}
	return { recent: recentRaw.slice(start), dropped: start };
}

/**
 * v0.21.9: re-cap a REPLAYED trim tail (D.2 in context-handler.ts, D.3 in
 * pipelineRun.ts). The replay paths return the cached trim view verbatim —
 * which bypasses the fire-time tail cap. A model switch mid-epoch can shrink
 * the window, leaving a replayed tail that fit the OLD window overflowing the
 * NEW one. Re-runs applyTailCap against the CURRENT window with the margin
 * stored at fire time (trimCache.safetyMarginPct), so the replayed view never
 * exceeds what the gate would allow. Pure — no runtime dependency.
 */
export function recapReplayedTail(opts: {
	recentRaw: readonly AgentMessage[];
	summaryAgentMsg: AgentMessage;
	ctxWindow: number;
	maxOutputTokens: number;
	outputReservePct: number;
	safetyMarginPct: number;
}): { recent: AgentMessage[]; dropped: number } {
	return applyTailCap({
		recentRaw: opts.recentRaw,
		summaryTokens: estimateAgentMessageBudgetTokens(opts.summaryAgentMsg),
		ctxWindow: opts.ctxWindow,
		maxOutputTokens: opts.maxOutputTokens,
		outputReservePct: opts.outputReservePct,
		safetyMarginPct: opts.safetyMarginPct,
	});
}
