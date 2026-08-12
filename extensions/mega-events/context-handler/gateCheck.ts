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
import { isThrashBlockedFor } from "./thrashGuard.js";

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
 * 3WF-2 ThrashGuard consult — refuse to fire a NEW compaction while the guard
 * is armed. After an ineffective compaction (the live window did not shrink),
 * `thrasguard.blocked_until` holds the live-token count the window must exceed
 * before re-firing is allowed.
 *
 * WHY THIS IS NOT INSIDE `evaluateGate`: the fast gate runs BEFORE the cached
 * replay path in context-handler.ts, and REPLAY MUST STAY EXEMPT. A replay is
 * free (no compute, no new checkpoint) and re-stabilises the provider KV-cache
 * prefix — suppressing it would cause the very cache invalidation the D.2/D.3
 * replay design exists to prevent. The guard's job is to stop wasted NEW
 * compaction work, not to withhold an already-computed view. So the consult is
 * called from the handler AFTER the replay block and BEFORE the debounce +
 * `invokePipeline` (the actual fire point), covering the percent branch and the
 * token branch alike since both converge there.
 *
 * Umbrella OFF ⇒ always false (byte-identical to v0.20.83). Non-fatal: a store
 * read error returns false — never refuse compaction on a store fault.
 */
export function thrashGuardBlocks(
	runtime: MegaRuntime,
	config: MegaConfig,
	currentTokens: number | null | undefined,
): boolean {
	if (!config.threeWayFailback) return false;
	if (currentTokens == null) return false;
	return isThrashBlockedFor(runtime, currentTokens, runtime.currentStateDir);
}

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
		// 3WF-2: under the umbrella, when the window is known AND the config is
		// tiered, honor the per-model Dashboard override exactly like the percent
		// branch (firePointPct % of the actual window) instead of the bare boot
		// fallback. custom / window-unknown / umbrella-OFF keep the bare
		// runtime.effectiveThreshold (window-unknown defers via +Infinity from
		// effectiveThresholdImpl; custom is the explicit absolute).
		let gateThreshold = runtime.effectiveThreshold;
		if (
			config.threeWayFailback &&
			config.tierPct != null &&
			runtime.lastCtxWindow > 0
		) {
			gateThreshold = Math.round(
				(perModelThreshold.firePointPct / 100) * runtime.lastCtxWindow,
			);
		}
		if (currentTokens < gateThreshold) {
			runtime.diagCtxFastGate++;
			return { kind: "return", view: tailResult() ?? undefined };
		}
		const check = autoCompactCheck(currentTokens, gateThreshold); // SERVER-STYLE CONFIRM (local)
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
