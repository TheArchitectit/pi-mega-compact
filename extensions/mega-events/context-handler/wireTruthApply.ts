/**
 * context-handler/wireTruthApply.ts — v0.21.12 wired-overhead runtime seam.
 *
 * Delegate-shell sibling extracted from context-handler.ts (extensions/ 400-line
 * soft limit). Holds the two wire-overhead call-site blocks that don't fit the
 * handler's budget:
 *  - sampleWireOverheadFromUsage: calibrate the per-model overhead EMA from a
 *    healthy usage-bearing context event (H_sample = usage.tokens − the REAL
 *    message-list estimate). MUST use the true estimate, not the pct-derived
 *    fallback — otherwise hSample ≈ 0 and the EMA trains itself to nothing.
 *  - applyWireTruthOverride: when the last assistant message is an error whose
 *    text matches the provider's 400 shape, treat the parsed requestTokens as
 *    ground-truth currentTokens for THIS event's gate, feed the EMA, and prefer
 *    the parsed availableTokens over runtime.lastCtxWindow.
 *
 * Both are no-op / byte-identical when config.wireOverhead is OFF. Non-fatal
 * everywhere; never throw on the agent loop. Structured logging only.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { parseWireTruth, sampleWireOverhead, readWireOverhead } from "./wireTruth.js";

/**
 * Calibrate the overhead EMA from a usage-bearing context event. Called once per
 * event (from the handler) when usage is finite + wireOverhead is ON.
 * `estimateTokens` MUST be the REAL message-list estimate (the engineView
 * estimate), never the pct-derived fallback — pi's percent reconstructs
 * usage.tokens exactly, so using it would force hSample ≈ 0 and erase the EMA
 * (0.6^5 retained after five healthy turns).
 */
export function sampleWireOverheadFromUsage(opts: {
	runtime: MegaRuntime;
	config: MegaConfig;
	modelId: string;
	usageTokens: number | null | undefined;
	resolvedWindow: number;
	estimateTokens: number;
}): void {
	const { runtime, config, modelId, usageTokens, resolvedWindow, estimateTokens } = opts;
	if (!config.wireOverhead) return; // byte-identical when OFF
	if (modelId === "" || usageTokens == null || !Number.isFinite(usageTokens) || resolvedWindow <= 0)
		return;
	const hSample = Math.max(0, usageTokens - estimateTokens);
	try {
		sampleWireOverhead(modelId, runtime.currentStateDir, hSample, resolvedWindow);
	} catch {
		/* non-fatal */
	}
}

/**
 * Resolve the invisible overhead H (tokens) the handler feeds to the tail-cap
 * budget at the fire/replay paths. Returns the calibrated EMA (or the
 * wireOverheadDefaultPct × window fallback when no sample exists yet). 0 when
 * wireOverhead is OFF or no model/window is known — byte-identical to v0.21.11.
 * Computed once so every call site passes the SAME H the gate used.
 */
export function resolveOverheadTokens(opts: {
	config: MegaConfig;
	modelId: string;
	resolvedWindow: number;
	stateDir: string;
}): number {
	const { config, modelId, resolvedWindow, stateDir } = opts;
	if (!config.wireOverhead || modelId === "" || resolvedWindow <= 0) return 0;
	const e = readWireOverhead(modelId, stateDir, resolvedWindow);
	return e > 0 ? e : config.wireOverheadDefaultPct * resolvedWindow;
}

/**
 * v0.21.12: invisible-overhead correction of the ESTIMATE-path token count. When
 * the token estimate came from the message list (not provider usage) AND
 * wireOverhead is ON, add H so the gate/thrash/tail-cap see the REAL request
 * size. H defaults to wireOverheadDefaultPct × window until a wire sample
 * calibrates it. Flag OFF ⇒ H = 0 (byte-identical to v0.21.11). The provider
 * usage path is ground truth for the message-list size and is never corrected.
 */
export function correctEstimateWithOverhead(opts: {
	config: MegaConfig;
	tokenSource: "usage" | "estimate" | "pct";
	rawTokens: number;
	modelId: string;
	resolvedWindow: number;
	stateDir: string;
}): number {
	const { config, tokenSource, rawTokens, modelId, resolvedWindow, stateDir } = opts;
	if (!config.wireOverhead || tokenSource !== "estimate" || resolvedWindow <= 0) return rawTokens;
	const h = modelId !== "" ? readWireOverhead(modelId, stateDir, resolvedWindow) : 0;
	const H = h > 0 ? h : config.wireOverheadDefaultPct * resolvedWindow;
	return rawTokens + H;
}

/**
 * Apply the wire-truth gate override for THIS event. Returns the (possibly
 * corrected) currentTokens. When the last assistant message is an error
 * (stopReason "error" or an errorMessage field) and its text matches the
 * provider's overflow error shape, the parsed requestTokens become
 * ground-truth currentTokens — even when our estimate reads far below every
 * threshold. Also feeds the EMA and prefers the parsed availableTokens over
 * runtime.lastCtxWindow when they differ. No-op (returns currentTokens
 * unchanged) when wireOverhead is OFF or no error/parse matched.
 */
export function applyWireTruthOverride(opts: {
	runtime: MegaRuntime;
	config: MegaConfig;
	messages: readonly AgentMessage[];
	modelId: string;
	resolvedWindow: number;
	estimateTokens: number;
	currentTokens: number;
}): number {
	const { runtime, config, messages, modelId, resolvedWindow, estimateTokens, currentTokens } = opts;
	if (!config.wireOverhead) return currentTokens; // byte-identical when OFF
	try {
		const last = messages[messages.length - 1] as
			| { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }
			| undefined;
		const lastText =
			typeof last?.errorMessage === "string"
				? last.errorMessage
				: typeof last?.content === "string"
					? last.content
					: Array.isArray(last?.content)
						? ((last.content as Array<{ text?: string }>)
							.map((b) => b?.text ?? "")
							.join(""))
						: "";
		const isError =
			last?.stopReason === "error" || typeof last?.errorMessage === "string";
		if (!isError || lastText.length === 0) return currentTokens;
		const parsed = parseWireTruth(lastText);
		if (parsed == null) return currentTokens;
		const wireTokens = parsed.requestTokens;
		runtime.lastCtxTokens = wireTokens;
		// EMA: the gap between the wire prompt and our message estimate (usage is
		// absent in the 400 case, so estimateTokens is the true message-list estimate).
		if (modelId !== "" && resolvedWindow > 0) {
			const hSample = Math.max(0, wireTokens - estimateTokens);
			sampleWireOverhead(modelId, runtime.currentStateDir, hSample, resolvedWindow);
		}
		// Prefer the provider's own available size for this event's math.
		if (parsed.availableTokens > 0 &&
			Math.abs(parsed.availableTokens - runtime.lastCtxWindow) > 0) {
			runtime.lastCtxWindow = parsed.availableTokens;
		}
		runtime.diagCtxWireTruth++;
		runtime.logger.info("wire_truth_parse", {
			sessionId: runtime.rt.sessionId,
			requestTokens: parsed.requestTokens,
			availableTokens: parsed.availableTokens,
			estimateTokens,
		});
		try {
			runtime.appendEvent("wire_truth_parse", {
				requestTokens: parsed.requestTokens,
				availableTokens: parsed.availableTokens,
				estimateTokens,
			});
		} catch {
			/* non-fatal */
		}
		return wireTokens;
	} catch {
		/* non-fatal */
		return currentTokens;
	}
}
