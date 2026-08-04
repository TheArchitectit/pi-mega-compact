/**
 * context-handler/pipelineRun.ts — adaptive-compression pipeline invocation.
 *
 * Extracted from context-handler.ts (delegate-shell split). Scales compression
 * strength + keepFrom depth with how close the context is to the model limit
 * (Fix E), invokes runCompact, and routes "skipped" outcomes back to a replay
 * of the cached trim view (D.3 free-stability win) instead of returning empty.
 * Returns a discriminated union: "return" (a tailed view to hand back to pi)
 * or "proceed" with the compact result + pressure for the live-trim stage.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunCompactResult } from "../../mega-pipeline.js";
import { runCompact } from "../../mega-pipeline.js";
import { pressureFromPct, pressureRatio } from "../../mega-config.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import type { TailResultFn } from "./gateCheck.js";

/** The non-skipped variant of the runCompact result. */
export type RanResult = Extract<RunCompactResult, { skipped: false }>;

/** Outcome of the pipeline-invocation stage. */
export type PipelineOutcome =
	| { kind: "return"; view: { messages: AgentMessage[] } | undefined }
	| { kind: "proceed"; ran: RanResult; pressure: number };

/**
 * Invoke the compaction pipeline with adaptive pressure. Returns a tailed view
 * ("return") when compaction skipped, or "proceed" with the non-skipped result
 * and the computed pressure (consumed by live-trim's critical-over hatch).
 */
export function invokePipeline(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
	ctx: ExtensionContext,
	opts: {
		messages: AgentMessage[];
		pct: number | null | undefined;
		currentTokens: number;
		tailResult: TailResultFn;
	},
): PipelineOutcome {
	// Adaptive compression (Fix E): scale compression strength + keepFrom depth
	// with how close we are to the model context limit. Null-safe: when the
	// token-fallback path ran (pct unavailable) use the token-basis pressure
	// (the same basis the runtime `pressure` getter uses for custom/no-window).
	const pressure =
		opts.pct != null
			? pressureFromPct(opts.pct)
			: pressureRatio(opts.currentTokens, runtime.effectiveThreshold);
	const ran = runCompact(pi, runtime, config, ctx, opts.messages, {
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
			runtime.trimCache.cut <= opts.messages.length
		) {
			const recent = opts.messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002: cached `cut` was sanitized by computeLiveTrimCut (src/boundary.ts); replayed verbatim, transcript only grows within an epoch.
			runtime.diagLiveTrimFires++;
			runtime.diagLiveTrimReplays++;
			runtime.snapshot(ctx);
			const skipView = [{ ...runtime.trimCache.summaryAgentMsg }, ...recent];
			return { kind: "return", view: opts.tailResult(skipView) ?? { messages: skipView } };
		}
		return { kind: "return", view: opts.tailResult() ?? undefined };
	}
	return { kind: "proceed", ran, pressure };
}
