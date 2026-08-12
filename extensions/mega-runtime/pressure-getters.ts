/**
 * pressure-getters.ts — extracted pressure accessors from the `MegaRuntime`
 * class (runtime.ts): the `pressure` / `effectiveThreshold` / `pressureBand`
 * getters, so the class body shrinks and the threshold logic is independently
 * testable.
 *
 * Follows the same context-interface + free-function + thin-delegate pattern as
 * effects.ts / game-state.ts / capture-model.ts / bind-repo.ts / perf.ts /
 * runtime-helpers.ts.
 */

import {
	pressureRatio,
	pressureFromPct,
	pressureBand,
	effectiveThresholdTokens,
	type MegaConfig,
	type PressureBand,
} from "../mega-config.js";

// ---------------------------------------------------------------------- types

/**
 * The slice of `MegaRuntime` the pressure accessors read. `MegaRuntime`
 * satisfies this structurally with no visibility changes — every field was
 * already public.
 */
export interface PressureContext {
	config: MegaConfig;
	lastCtxTokens: number | null;
	lastCtxPercent: number | null;
	lastCtxWindow: number;
}

// ------------------------------------------------------------------ pressure

/**
 * Live 0–1 pressure — how full the context window is relative to the
 * compaction threshold.
 *
 * RECONCILE (BACKLOG dual-basis flicker): when the model context window is
 * known we base pressure consistently on the *percentage* basis
 * (`lastCtxPercent / (tierPct*100)`). This keeps the band stable whether the
 * latest context event carried a token count or only a percentage, so the
 * threshold comparison doesn't jump when a token-count event arrives vs a
 * percent-only event. We only fall back to the token-count basis
 * (`config.thresholdTokens`) when the window is unknown (e.g. before the first
 * context event, or a `custom` tier with no tierPct). Always finite + in [0,1].
 */
export function pressureImpl(self: PressureContext): number {
	if (
		self.lastCtxWindow > 0 &&
		self.config.tierPct != null &&
		self.lastCtxPercent != null
	) {
		// pressureFromPct(x) = x/100, and x = lastCtxPercent/tierPct, so this is
		// exactly the intended lastCtxPercent/(tierPct*100) 0–1 ratio: at the
		// fire point (lastCtxPercent == tierPct*100) pressure == 1.0, matching the
		// token-based pressureRatio(currentTokens, effectiveThreshold) reading so
		// the band doesn't jump when a token-count vs percent-only event arrives.
		return pressureFromPct(self.lastCtxPercent / self.config.tierPct);
	}
	if (
		self.lastCtxTokens != null &&
		self.lastCtxTokens > 0 &&
		self.config.thresholdTokens > 0
	) {
		return pressureRatio(self.lastCtxTokens, self.config.thresholdTokens);
	}
	return pressureFromPct(self.lastCtxPercent);
}

// -------------------------------------------------------- effectiveThreshold

/**
 * The live compaction FIRE POINT in tokens: the effective threshold scaled by
 * the current model context window (`tierPct * window`) when known, else the
 * boot fallback `config.thresholdTokens`. This is what the FAST GATE /
 * `autoCompactCheck` / agent_end durable-trigger compare against, so
 * compaction fires at tier% of the window for ANY model size (200k or 1M),
 * always below pi's native auto-compaction (~80% of window).
 */
export function effectiveThresholdImpl(self: PressureContext): number {
	// 3WF-2 threshold invariant: under the umbrella, a tiered config with an
	// UNKNOWN window (lastCtxWindow <= 0) DEFERS — auto-compaction must never
	// substitute a guessed window. Returning +Infinity keeps every downstream
	// `tokens >= threshold` comparison false (gateCheck token path,
	// agent_end durable trigger, live-trim re-compact), so no compaction fires
	// until the provider reports a real window. custom (tierPct null) and
	// umbrella-OFF fall through to the legacy helper (byte-identical).
	if (
		self.config.threeWayFailback &&
		self.config.tierPct != null &&
		self.lastCtxWindow <= 0
	) {
		return Number.POSITIVE_INFINITY;
	}
	return effectiveThresholdTokens({
		tierPct: self.config.tierPct,
		fallbackThreshold: self.config.thresholdTokens,
		window: self.lastCtxWindow,
	});
}

// -------------------------------------------------------------- pressureBand

/** Live discrete pressure band (low/medium/high/ultra/mega) over `pressure`. */
export function pressureBandImpl(self: PressureContext): PressureBand {
	return pressureBand(pressureImpl(self));
}
