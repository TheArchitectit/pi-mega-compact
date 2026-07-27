/**
 * runtime-helpers.ts — extracted private helpers from the `MegaRuntime` class
 * (runtime.ts) so the class body shrinks and the pure/instance logic is
 * independently testable.
 *
 * Follows the same context-interface + free-function + thin-delegate pattern as
 * effects.ts / game-state.ts / capture-model.ts / bind-repo.ts / perf.ts.
 */

import type { SessionRuntime } from "./helpers.js";
import type { TickerEntry } from "./widget-types.js";
import type { ModelSnapshot } from "../../src/store/sqlite.js";
import { detectCrossRepoDrift } from "../../src/driftDetection.js";
import { turnLevel } from "../../src/game/scoring.js";

// ---------------------------------------------------------------------- types

/**
 * The slice of `MegaRuntime` the extracted helpers read (and, for `driftStatus`,
 * write). `MegaRuntime` satisfies this structurally once `driftCache` is public.
 */
export interface RuntimeHelpersContext {
	rt: SessionRuntime;
	activeEffect: {
		type: "pulse" | "flash";
		role: "accent" | "mega" | "red";
		startedAt: number;
		durationMs: number;
	} | null;
	lastCtxTokens: number | null;
	lastCtxPercent: number | null;
	lastCtxWindow: number;
	activeAgents: number;
	currentTurn: number;
	statusKey: string | undefined;
	currentModel: ModelSnapshot | undefined;
	gameStateBump: number;
	megaCacheFlare: boolean;
	megaCacheFlarePct: number;
	levelUpFlare: boolean;
	achievementFlare: boolean;
	achievementFlareTitles: string[];
	tierTrace: string | undefined;
	lastWhy: string | undefined;
	pulsing: boolean;
	ticker: TickerEntry[];
	/** Cross-repo drift cache (30s TTL). Mutated by `driftStatusImpl`. */
	driftCache: { at: number; status: "ok" | "warn" } | null;
}

// -------------------------------------------------------------- materialSig

/** v0.8.5: cheap material-change signature over live runtime fields (no
 *  SQLite). Two snapshots with the same signature produce identical
 *  dashboard.json + widgetData, so the 6 synchronous SQLite opens + the
 *  writeFileSync(dashboard.json) can be skipped. Built from in-memory state
 *  only; `gameStateBump` covers cross-process game_state edits (fs.watch) +
 *  in-process /mega-game writes (bumpGameState) + repo switches (bindRepo).
 *  The transient flare flags are included so a one-shot flare forces the
 *  recompute that renders (then clears) it for exactly one cycle. */
export function materialSigImpl(ctx: RuntimeHelpersContext): string {
	const rt = ctx.rt;
	const ae = ctx.activeEffect;
	return JSON.stringify([
		ctx.lastCtxTokens, ctx.lastCtxPercent, ctx.lastCtxWindow,
		ctx.activeAgents, ctx.currentTurn,
		rt.compactCount, rt.tokensSaved, rt.dedupSkips, rt.dedupAttempts,
		rt.recallInjections, rt.cacheHitTokens, rt.persistedThisSession,
		rt.lastCheckpointId ?? null, rt.lastCompactedFrom, rt.lastCompactedTokens,
		ctx.statusKey ?? null,
		ctx.currentModel?.modelId ?? null, ctx.currentModel?.provider ?? null,
		ae ? `${ae.type}:${ae.role}:${ae.startedAt}` : null,
		ctx.gameStateBump,
		ctx.megaCacheFlare, ctx.megaCacheFlarePct,
		ctx.levelUpFlare, ctx.achievementFlare,
		ctx.achievementFlareTitles.join("|"),
		ctx.tierTrace ?? null, ctx.lastWhy ?? null, ctx.pulsing,
		ctx.ticker.length,
	]);
}

// -------------------------------------------------------------- embedderName

/** Active embedder name for the memory-store line (Trigram default / MiniLM).
 *  Pure — reads only `process.env` (the same flag the embedder factory reads). */
export function embedderNameImpl(): string {
	// MINILM_EMBEDDER flag lives in src/config/dedup.ts; read the same env var
	// the embedder factory uses so the label matches what's actually running.
	return process.env.MEGACOMPACT_MINILM === "true" ||
		process.env.MEGACOMPACT_MINILM === "1"
		? "MiniLM"
		: "Trigram";
}

// -------------------------------------------------------------- driftStatus

/** Cross-repo drift status (ok | warn), cached for 30s (opens the registry DB). */
export function driftStatusImpl(ctx: RuntimeHelpersContext): "ok" | "warn" {
	const now = Date.now();
	if (ctx.driftCache && now - ctx.driftCache.at < 30_000)
		return ctx.driftCache.status;
	let status: "ok" | "warn" = "ok";
	try {
		const report = detectCrossRepoDrift();
		status = report.totals.warn > 0 ? "warn" : "ok";
	} catch {
		status = "ok";
	}
	ctx.driftCache = { at: now, status };
	return status;
}

// -------------------------------------------------------------- getTurnLevel

/** S33: player level for game mode — floor(log2(turns+1))+1 (gentle).
 *  Defensive: non-finite/negative collapses to 1 (never NaN). */
export function getTurnLevelImpl(ctx: RuntimeHelpersContext): number {
	return turnLevel(ctx.currentTurn);
}
