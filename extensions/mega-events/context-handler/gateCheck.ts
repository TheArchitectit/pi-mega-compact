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
import { resolveOutputReserve } from "./headroom.js";

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
			/**
			 * v0.21.9: true when the proceed was forced by the output-headroom
			 * check (the request would overflow the model window before reaching
			 * the percent/token fire point). Consumed by thrashGuardBlocks so an
			 * overflow-bound fire is never refused by the thrash guard — an
			 * overflowed session is unrecoverable (2026-08-19 32k incident).
			 */
			headroomExceeded?: boolean;
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
	headroomExceeded?: boolean,
): boolean {
	if (!config.threeWayFailback) return false;
	if (currentTokens == null) return false;
	// v0.21.9: an overflow-bound fire (headroomExceeded) is EXEMPT from the
	// thrash guard. The guard exists to stop wasted re-compaction when the
	// window refuses to shrink; but an overflowed request is not "wasted work"
	// — it is the model about to 400. Blocking that fire reproduces the
	// 2026-08-19 32k deadlock (compact never → request > window → error loop).
	if (headroomExceeded) return false;
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

	// Phase H: output-error catch. A truncated model output (S28
	// stopReason==='length' — "Response was truncated before completion") trips
	// a one-shot force-compact so the next compaction runs IMMEDIATELY, freeing
	// input headroom for the model's next response. This closes the
	// small-context-model deadlock: the model truncates MID-OUTPUT below the
	// 80% INPUT threshold (so the gate never fires) → "compact never" → every
	// subsequent response also truncates. lengthStop.ts sets this flag
	// alongside its auto-continue nudge; gated by config.outputErrorCompact
	// (default ON; OFF = byte-identical pre-H). One-shot: cleared on consumption.
	// thrashGuardBlocks is consulted separately by the handler; in the reported
	// "compact never" case compactCount===0 so the guard is never armed and will
	// not block this trip.
	if (config.outputErrorCompact && runtime.rt?.forceCompactNextGate) {
		runtime.rt.forceCompactNextGate = false;
		runtime.diagCtxOutputErrorTrip++;
		return { kind: "proceed", perModelThreshold };
	}

	// v0.21.9 OUTPUT-HEADROOM GATE (the root-cause fix for the 32k truncation
	// loop). The percent/token fire points above judge only INPUT utilization
	// (tier% of the window), but a request's budget is
	//   input tokens + the model's output budget + safety margin.
	// On a small-window model with a large maxTokens (the user's 32k/20k
	// GLM-4.7), the request overflows at ~32% INPUT (21.4k + 20k > 32.768k) —
	// long before any percent gate fires → provider 400 "request exceeds the
	// available context size" every turn → the poisoned-error loop. Phase H only
	// reacts to stopReason 'length' (mid-output truncation); a pre-output 400
	// never arms it, so "compact never". This check fires the compaction
	// BEFORE the overflow instead of after.
	//
	// PERCENT-BASED (LTS invariant — must work at every window size: 32k, 64k,
	// 200k, 1M, 5M): the reserve is a FRACTION of the model's own window via
	// resolveOutputReserve (plausible declared maxTokens wins, else
	// clamp(MEGACOMPACT_OUTPUT_RESERVE_PCT, 10–95%) × window). Same math, any
	// size. window <= 0 (unknown) ⇒ deferred (never guess a window), matching
	// the effectiveThresholdImpl Phase-C invariant. Gated on
	// config.overflowHeadroom (default ON; OFF = byte-identical pre-v0.21.9).
	// Thrash-guard exemption: headroomExceeded rides along on the proceed so the
	// handler's thrash consult never refuses an overflow-bound fire (see
	// thrashGuardBlocks above) — an overflowed session is unrecoverable, so a
	// wasted re-fire is always the better outcome (2026-08-19 incident).
	if (
		config.overflowHeadroom &&
		runtime.lastCtxWindow > 0 &&
		Number.isFinite(currentTokens) &&
		currentTokens > 0
	) {
		const { reserveTokens, fallbackUsed } = resolveOutputReserve(
			runtime.lastCtxWindow,
			runtime.currentModel?.maxTokens ?? 0,
			config.outputReservePct,
		);
		const headroomMargin = Math.ceil(
			runtime.lastCtxWindow * (perModelThreshold.safetyMarginPct / 100),
		);
		if (currentTokens + reserveTokens + headroomMargin >= runtime.lastCtxWindow) {
			runtime.diagCtxHeadroomTrip++;
			runtime.logger.info("gate-headroom-trip", {
				sessionId: runtime.rt.sessionId,
				currentTokens,
				ctxWindow: runtime.lastCtxWindow,
				reserveTokens,
				fallbackUsed,
				marginPct: perModelThreshold.safetyMarginPct,
			});
			return { kind: "proceed", perModelThreshold, headroomExceeded: true };
		}
	}

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
