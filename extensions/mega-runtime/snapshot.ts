/**
 * snapshot.ts — pure computation of the live stats widget data.
 *
 * Extracted from `MegaRuntime.snapshot()` in state.ts so the computation is
 * a pure function with no side effects beyond returning data. The caller
 * (state.ts) handles side-effects (level-up flare, flare consumption, render).
 */

import { C } from "./widget.js";
import { ownVersion } from "./helpers.js";
import { getTheme } from "../../src/config/themes.js";
import type { VectorStats } from "../../src/vector-read.js";
import type { RepoStats } from "../../src/store/sqlite/stats.js";
import type { GameState } from "../../src/store/sqlite/game-state.js";
import type { ModelSnapshot } from "../../src/store/sqlite/model-snapshots.js";
import type { WidgetData, TickerEntry } from "./widget.js";

// ------------------------------------------------------------------ helpers

function dedupStr(storageRate: number): string {
	// Storage dedup rate is cumulative (store-wide, per-repo) and survives
	// session resets. Always show a number (decimal for sub-10%).
	return storageRate * 100 >= 10
		? `${Math.round(storageRate * 100)}%`
		: `${(storageRate * 100).toFixed(1)}%`;
}

function pctLabel(lastCtxPercent: number | null): string {
	if (lastCtxPercent == null) return "?%";
	if (lastCtxPercent > 100) return `>100%`; // S29: overshoot warning
	return `${Math.round(lastCtxPercent * 10) / 10}%`;
}

function tokLabel(v: number | null): string {
	return v != null ? `${Math.round(v / 1000)}k` : "?";
}

function maxLabel(v: number): string {
	return v > 0 ? `${Math.round(v / 1000)}k` : "?";
}

function agentStr(activeAgents: number): string {
	const agentLabel =
		activeAgents > 0
			? `\u{1F916} ${activeAgents} agent${activeAgents === 1 ? "" : "s"}`
			: `${C.dim}\u{1F916} idle${C.reset}`;
	return ` │ ${agentLabel}`;
}

// ----------------------------------------------------------------- types

export interface SnapshotInput {
	// Context-window counters
	lastCtxTokens: number | null;
	lastCtxWindow: number;
	lastCtxPercent: number | null;
	activeAgents: number;
	currentTurn: number;
	statusKey: string | undefined;

	// Store stats (pre-computed outside this function)
	st: VectorStats;
	repo: RepoStats;

	// Session counters
	rtTokensSaved: number;
	lastCompactAt: number | null;

	// Widget display fields
	ticker: TickerEntry[];
	lastWhy: string | undefined;
	tierTrace: string | undefined;
	pulsing: boolean;

	// Pressure / trigger state
	pressureBand: "low" | "medium" | "high" | "ultra" | "mega";
	configTier: string;
	ready: boolean;
	armed: boolean;

	// Model snapshot (pre-fetched)
	modelSnap: ModelSnapshot | undefined;

	// Provider prompt cache hit rate (lifetime avg, required — callers compute once).
	providerCachePct: number;

	// Game-mode state (callers that need real-time values pass lambdas)
	getCachedGameState: () => GameState;
	getTurnLevel: () => number;
	embedderName: () => string;
	driftStatus: () => "ok" | "warn";

	// Flare flags (one-shot per render cycle)
	megaCacheFlare: boolean;
	megaCacheFlarePct: number;
	levelUpFlare: boolean;
	achievementFlare: boolean;
	achievementFlareTitles: string[];

	// v0.8.3: ambient border effect
	activeEffect: {
		type: "pulse" | "flash";
		role: "accent" | "mega" | "red";
		startedAt: number;
		durationMs: number;
	} | null;

	lastActivityAt: number;

	/** A3: per-turn cache hit percentage (most recent turn's ratio, separate
	 *  from providerCachePct which is the running average). Optional — when null
	 *  the cache-hit line is omitted from the widget. */
	perTurnCacheHitPct?: number;
}

export interface SnapshotResult {
	widgetData: WidgetData;
	curLevel: number;
}

// ---------------------------------------------------------- main computation

/**
 * Pure computation of the live stats widget data.
 *
 * Takes a snapshot of the current MegaRuntime state and returns a fully
 * populated `WidgetData` object plus the computed turn level. No side effects
 * — callers are responsible for flare consumption, level-up checks, and render.
 */
export function computeMegaSnapshot(p: SnapshotInput): SnapshotResult {
	const st = p.st;
	const repo = p.repo;
	const liveBand = p.pressureBand;

	// ── header strings ────────────────────────────────────────────────────
	const tierLabel = `${C.bold}${liveBand}${C.reset}${C.gray}·${p.configTier}${C.reset}`;
	const triggerLabel = p.ready
		? `${C.green}● ready${C.reset}`
		: p.armed
			? `${C.amber}◐ armed${C.reset}`
			: `${C.gray}○ idle${C.reset}`;
	const pctStr = pctLabel(p.lastCtxPercent);
	const tokStr = tokLabel(p.lastCtxTokens);
	const maxStr = maxLabel(p.lastCtxWindow);
	const dedupStr_ = dedupStr(st.storageDedupRate);
	const agentStr_ = agentStr(p.activeAgents);
	const turnStr = p.currentTurn > 0 ? ` │ turn ${p.currentTurn}` : "";

	// ── reconciled in/out view (session + repo) ───────────────────────────
	const sessIn = p.rtTokensSaved + st.totalTokenEstimate;
	const sessKept = st.totalTokenEstimate;
	const sessPct = sessIn > 0 ? p.rtTokensSaved / sessIn : 0;
	const repoIn = repo.tokensSaved + repo.totalTokenEstimate;
	const repoKept = repo.totalTokenEstimate;
	const repoPct = repoIn > 0 ? repo.tokensSaved / repoIn : 0;
	const sTxt = (sessPct * 100).toFixed(sessPct * 100 >= 10 ? 0 : 1);
	const rTxt = (repoPct * 100).toFixed(repoPct * 100 >= 10 ? 0 : 1);
	const ctxPct = p.lastCtxPercent != null ? p.lastCtxPercent / 100 : 0;

	// ── model + provider (S26 capture) for the header ─────────────────────
	const modelName = p.modelSnap?.modelName ?? p.modelSnap?.modelId ?? "?";
	const modelStr = p.modelSnap?.provider
		? `${modelName}·${p.modelSnap.provider}`
		: modelName;

	// ── since-last-compact (ms; null until first compaction this session) ──
	const sinceCompact =
		p.lastCompactAt != null ? Date.now() - p.lastCompactAt : null;

	// ── memory store: embedder + compression ratio ────────────────────────
	const embedderName_ = p.embedderName();
	const compRatio =
		st.originalTokens > 0 && st.totalTokenEstimate > 0
			? st.originalTokens / st.totalTokenEstimate
			: st.originalTokens > 0
				? 1
				: 0;
	const compStr = compRatio >= 1 ? `${compRatio.toFixed(1)}x` : "—";

	// ── cross-repo drift status ──────────────────────────────────────────
	const driftStatus_: "ok" | "warn" = p.driftStatus();
	const agentsActive = p.activeAgents > 0;

	// ── S31: game-mode state ──────────────────────────────────────────────
	const gs = p.getCachedGameState();
	const curLevel = p.getTurnLevel();
	const cachePct = p.providerCachePct;

	const widgetData: WidgetData = {
		version: ownVersion(),
		tierLabel,
		triggerLabel,
		pctStr,
		tokStr,
		maxStr,
		ctxPct,
		chk: st.checkpointCount,
		agentStr: agentStr_,
		turnStr,
		dedupStr: dedupStr_,
		sessIn,
		sessKept,
		sTxt,
		repoIn,
		repoKept,
		rTxt,
		repoChk: repo.checkpointCount,
		repoSess: repo.sessionCount,
		modelStr,
		sinceCompact,
		embedderName: embedderName_,
		compStr,
		driftStatus: driftStatus_,
		agentsActive,
		fresh: Date.now() - p.lastActivityAt < 4000,
		ticker: p.ticker,
		lastWhy: p.lastWhy,
		tierTrace: p.tierTrace,
		pulsing: p.pulsing,
		// S31 game-mode fields:
		gameMode: gs.game_mode_on,
		theme: getTheme(gs.theme) ? gs.theme : "transparent",
		tuiMode: gs.tui_display_mode,
		level: curLevel,
		cachePct,
		megaCacheFlare: p.megaCacheFlare,
		megaCacheFlarePct: p.megaCacheFlarePct,
		perTurnCacheHitPct: p.perTurnCacheHitPct,
		levelUpFlare: p.levelUpFlare,
		achievementFlare: p.achievementFlare,
		achievementFlareTitles: p.achievementFlareTitles,
		// v0.8.3: ambient border effect — threaded live so the widget can
		// compute the per-frame phase and render animated borders.
		activeEffect: p.activeEffect,
	};

	return { widgetData, curLevel };
}
