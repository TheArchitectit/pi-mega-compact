/**
 * context-handler/gateCheck.ts — S29 fast-gate threshold evaluation.
 *
 * Extracted from context-handler.ts (delegate-shell split). Drives the
 * auto-trigger off the context % (the number the menu bar shows), NOT the
 * token count — the model under-reports tokens, so a token-only gate misses
 * the overshoot that causes max-output-tokens truncation. Returns a
 * discriminated union: either "return" (a tailed view to hand back to pi) or
 * "proceed" with the resolved per-model threshold for the live-trim tail cap.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	resolveModelThreshold,
	DEFAULT_SAFETY_MARGIN_PCT,
	DEFAULT_FIRE_POINT_PCT,
} from "../../../src/store/sqlite.js";
import { autoCompactCheck } from "../../../src/compact.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";

/** Tail-injection closure shape produced by buildTailResult (tailResult.ts). */
export type TailResultFn = (
	msgs?: readonly AgentMessage[],
) => { messages: AgentMessage[] } | undefined;

/** Outcome of the fast-gate evaluation. */
export type GateOutcome =
	| { kind: "return"; view: { messages: AgentMessage[] } | undefined }
	| {
			kind: "proceed";
			perModelThreshold: { safetyMarginPct: number; firePointPct: number };
	  };

/**
 * Evaluate whether the current context warrants compaction. Returns a tailed
 * view ("return") when the gate does not pass, or "proceed" with the resolved
 * per-model threshold (reused by the live-trim token-budget tail cap).
 */
export function evaluateGate(
	runtime: MegaRuntime,
	config: MegaConfig,
	opts: {
		pct: number | null | undefined;
		currentTokens: number;
		tailResult: TailResultFn;
	},
): GateOutcome {
	const pct = opts.pct;
	const currentTokens = opts.currentTokens;
	const tailResult = opts.tailResult;

	// S52 / v0.16.1: per-model threshold override. The user can tune the
	// fire point + safety margin PER MODEL (different providers' models range
	// 8K-1M+ context, so one global tier % is wrong). Falls back to env/default
	// when no override row exists. Computed once here + reused in the tail cap
	// below; the lookup is a single SQLite PK hit (cheap; cached after the
	// first read in a session).
	const modelIdForThreshold = runtime.currentModel?.modelId ?? null;
	const perModelThreshold = resolveModelThreshold(modelIdForThreshold, {
		safetyMarginFallback: DEFAULT_SAFETY_MARGIN_PCT,
		firePointFallback:
			config.tierPct != null
				? Math.round(config.tierPct * 100)
				: DEFAULT_FIRE_POINT_PCT,
		stateDir: runtime.currentStateDir,
	});

	// S29 FAST GATE: `custom` (absolute MEGACOMPACT_THRESHOLD_TOKENS,
	// tierPct null) is an explicit opt-out of percent scaling — it keeps the
	// token gate. When pct is unavailable (window unknown / a model that
	// doesn't report percent) a tiered config falls back to the token gate
	// (S27 boot-fallback guarantee) instead of skipping compaction — a
	// percent-only gate would regress that.
	let gatePassed = false;
	if (config.tierPct != null && pct != null) {
		// Per-model override is a % (10-90); tierPct is a fraction (0.1-1.0).
		// Prefer the override; fall back to autoPctTrigger + tierPct.
		const tierPctFraction = config.autoPctTrigger ?? config.tierPct;
		const perModelFraction = perModelThreshold.firePointPct / 100;
		const firePct =
			modelIdForThreshold != null ? perModelFraction : tierPctFraction;
		gatePassed = pct / 100 >= firePct;
	} else {
		// custom tier OR tiered-but-pct-unavailable → token gate (S27 fallback).
		if (currentTokens < runtime.effectiveThreshold) {
			runtime.diagCtxFastGate++;
			return { kind: "return", view: tailResult() ?? undefined };
		}
		const check = autoCompactCheck(currentTokens, runtime.effectiveThreshold); // SERVER-STYLE CONFIRM (local)
		if (!check.shouldCompact) {
			runtime.diagCtxNoCompact++;
			return { kind: "return", view: tailResult() ?? undefined };
		}
		gatePassed = true;
	}
	if (!gatePassed) {
		runtime.diagCtxFastGate++;
		return { kind: "return", view: tailResult() ?? undefined };
	}
	return { kind: "proceed", perModelThreshold };
}
