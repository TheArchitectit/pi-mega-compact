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
import { recordCompactLatency } from "../../mega-runtime/vc-observer.js";
import { decideLivePath } from "../../mega-runtime/vector-cortex-live.js";
import { recapReplayedTail } from "./headroom.js";
import { defaultClock, type RolloutEvidence } from "../../../src/vector-cortex/rollout/gate.js";
import { VC5C_ENABLED } from "../../../src/config/vector-cortex.js";

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
		overheadTokens?: number;
	},
): PipelineOutcome {
	// VC5C: emit the rollout decision per compact event (observability seam).
	// vcGate/vcHardFaults are not yet declared on MegaRuntime.rt — cast to the
	// rollout shapes. Best-effort + non-fatal; decision does NOT gate behavior yet.
	if (VC5C_ENABLED()) {
		try {
			const clock = defaultClock();
			// Conservative evidence: fresh in-memory window (elapsed=0), not
			// powered, so the gate can't advance — but events/sessions carry real
			// values so the decision events reflect actual runtime activity rather
			// than degrading every epoch to an empty mode-C read.
			const evidence: RolloutEvidence = {
				windowStartMs: clock.now(),
				powered: false,
				events: runtime.rt.compactCount,
				sessions: 1,
				hardFaults:
					(runtime.rt as { vcHardFaults?: import("../../../src/vector-cortex/rollout/types.js").RolloutHardFault[] })
						.vcHardFaults ?? [],
			};
			const decision = decideLivePath(runtime.rt.sessionId, {
				emit: runtime.appendEvent.bind(runtime),
				clock,
				currentGate:
					(runtime.rt as { vcGate?: 0 | 1 | 2 | 3 | 4 }).vcGate ?? 0,
				evidence,
				hardFaults: evidence.hardFaults,
			});
			runtime.appendEvent("vector_cortex_rollout_decision", {
				sessionId: runtime.rt.sessionId,
				vcActive: decision.vcActive,
				forcedPreVc: decision.forcedPreVc,
				mode: decision.mode,
				bucket: decision.bucket,
				gateIndex: decision.gateIndex,
				promotionBlocked: decision.promotionBlocked,
			});
		} catch {
			/* non-fatal: rollout decision emission never breaks compaction */
		}
	}
	// Adaptive compression (Fix E): scale compression strength + keepFrom depth
	// with how close we are to the model context limit. Null-safe: when the
	// token-fallback path ran (pct unavailable) use the token-basis pressure
	// (the same basis the runtime `pressure` getter uses for custom/no-window).
	const pressure =
		opts.pct != null
			? pressureFromPct(opts.pct)
			: pressureRatio(opts.currentTokens, runtime.effectiveThreshold);
	const t0 = Date.now();
	const ran = runCompact(pi, runtime, config, ctx, opts.messages, {
		compressionPressure: pressure,
	});
	// VC0A: record compact latency on the eval observer (mode A) on every
	// outcome so the dashboard histogram reflects real data. No-op when the
	// observer is absent (flag off / construction failure).
	recordCompactLatency(
		runtime,
		Date.now() - t0,
		runtime.rt.sessionId,
		runtime.rt.compactCount,
	);
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
			const recentRaw = opts.messages.slice(runtime.trimCache.cut); // guardrails-allow PREVENT-PI-002: cached `cut` was sanitized by computeLiveTrimCut (src/boundary.ts); replayed verbatim, transcript only grows within an epoch.
			// v0.21.9: RE-CAP the replayed tail against the CURRENT window —
			// the D.3 skip-replay bypasses the fire-time tail cap exactly like
			// D.2; a model switch mid-epoch can shrink the window below what
			// the cached view was built for. No-op when the tail already fits.
			const { recent } = recapReplayedTail({
				recentRaw,
				summaryAgentMsg: runtime.trimCache.summaryAgentMsg,
				ctxWindow: runtime.lastCtxWindow,
				maxOutputTokens: runtime.currentModel?.maxTokens ?? 0,
				outputReservePct: config.outputReservePct,
				safetyMarginPct: runtime.trimCache.safetyMarginPct,
				overheadTokens: opts.overheadTokens ?? 0,
			});
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
