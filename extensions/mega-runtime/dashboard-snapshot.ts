/**
 * dashboard-snapshot.ts — extracted DashboardSnapshot builder for MegaRuntime.
 *
 * Builds the ~130-line DashboardSnapshot data object that was previously
 * inlined inside MegaRuntime.snapshot(). Pure data-gathering — no I/O, no
 * side effects.
 */

import type { DashboardSnapshot } from "../mega-dashboard.js";

// ---------------------------------------------------------------------- types

export interface SnapshotBuildContext {
	// Config
	readonly config: {
		readonly tier: string;
		readonly fastGatePct: number;
		readonly tierPct: number | null;
		readonly anchorUserMessages: number;
		readonly preserveRecent: number;
		readonly auto: boolean;
		readonly autoInline: boolean;
	};
	// Runtime
	readonly rt: {
		readonly sessionId: string;
		readonly persistedThisSession: boolean;
		readonly lastCheckpointId: string | undefined;
		readonly lastCompactedFrom: number;
		readonly lastCompactedTokens: number;
		readonly tokensSaved: number;
		readonly compactCount: number;
		readonly recallInjections: number;
		readonly cacheHitTokens: number;
		readonly dedupSkips: number;
		readonly dedupAttempts: number;
	};
	// Live metrics
	readonly pressureBand: string;
	readonly pressure: number;
	readonly effectiveThreshold: number;
	readonly statusKey: string | undefined;
	readonly lastCtxTokens: number | null;
	readonly lastCtxPercent: number | null;
	readonly lastCtxWindow: number;
	readonly diagCtxFastGate: number;
	readonly diagLiveTrimFires: number;
	readonly diagLiveTrimReplays: number;
	readonly errorRetryCount: number;
	readonly consecutiveErrors: number;
	readonly ERROR_RETRY_MAX_CONSECUTIVE: number;
	readonly errorRetryHardStop: boolean;
	// R7 (retry redesign): session-global cap + poisoned-context counters.
	readonly sessionRetryCount: number;
	readonly sessionRetryMax: number;
	readonly poisonedCount: number;
	readonly activeAgents: number;
	readonly currentTurn: number;
	readonly currentModel: { providerName: string | null; modelId: string; provider: string; inputRate: number; outputRate: number } | null | undefined;
	// Store stats (precomputed by caller)
	readonly st: { checkpointCount: number; totalTokenEstimate: number; originalTokens: number; tokensSaved: number; injectedCount: number; dedupHitRate: number; storageDedupRate: number; dedupAttempts: number; dedupCollapsed: number };
	readonly repo: { checkpointCount: number; totalTokenEstimate: number; originalTokens: number; tokensSaved: number; sessionCount: number; dedupAttempts: number; dedupCollapsed: number; storageDedupRate: number };
	readonly di: { regionsRetained: number; compressedOriginalBytes: number; duplicatesCollapsed: number; bytesPermanentlyDeleted: number };
}

// ---------------------------------------------------------- buildDashboardSnapshot

/** Build the DashboardSnapshot object from precomputed store/live metrics.
 *  Pure — no I/O, no side effects. */
export function buildDashboardSnapshot(ctx: SnapshotBuildContext): DashboardSnapshot {
	const armed = (ctx.lastCtxTokens ?? 0) >= ctx.effectiveThreshold * ctx.config.fastGatePct;
	const ready = armed && (ctx.lastCtxTokens ?? 0) >= ctx.effectiveThreshold;
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		tier: ctx.pressureBand,
		presetTier: ctx.config.tier,
		pressure: ctx.pressure,
		config: {
			fastGatePct: ctx.config.fastGatePct,
			thresholdTokens: ctx.effectiveThreshold,
			tierPct: ctx.config.tierPct,
			effectiveThresholdPct: ctx.config.tierPct != null ? ctx.config.tierPct * 100 : null,
			anchorUserMessages: ctx.config.anchorUserMessages,
			preserveRecent: ctx.config.preserveRecent,
			auto: ctx.config.auto,
			autoInline: ctx.config.autoInline,
		},
		session: {
			id: ctx.rt.sessionId,
			state: ctx.statusKey ?? "idle",
			persistedThisSession: ctx.rt.persistedThisSession,
			lastCheckpointId: ctx.rt.lastCheckpointId ?? null,
			lastCompactedFrom: ctx.rt.lastCompactedFrom,
			lastCompactedTokens: ctx.rt.lastCompactedTokens,
			dedupSkips: ctx.rt.dedupSkips,
			dedupAttempts: ctx.rt.dedupAttempts,
		},
		context: {
			tokens: ctx.lastCtxTokens,
			percent: ctx.lastCtxPercent,
			contextWindow: ctx.lastCtxWindow,
		},
		trigger: {
			armed,
			ready,
			currentTokens: ctx.lastCtxTokens,
			thresholdTokens: ctx.effectiveThreshold,
			fastGatePct: ctx.config.fastGatePct,
			tierPct: ctx.config.tierPct,
			effectiveThresholdPct: ctx.config.tierPct != null ? ctx.config.tierPct * 100 : null,
		},
		store: {
			checkpointCount: ctx.st.checkpointCount,
			totalTokenEstimate: ctx.st.totalTokenEstimate,
			originalTokens: ctx.st.originalTokens,
			tokensSaved: ctx.st.tokensSaved,
			injectedCount: ctx.st.injectedCount,
			dedupHitRate: ctx.st.dedupHitRate,
			// Session-scoped dedup stats from runtime counters, NOT the
			// cumulative meta table (which is repo-wide and belongs in the
			// repo card below). rt.dedupSkips/dedupAttempts reset on session
			// restart so the session card shows only this session's dedup.
			storageDedupRate: ctx.rt.dedupAttempts > 0 ? ctx.rt.dedupSkips / ctx.rt.dedupAttempts : 0,
			dedupAttempts: ctx.rt.dedupAttempts,
			dedupCollapsed: ctx.rt.dedupSkips,
		},
		crew: {
			activeAgents: ctx.activeAgents,
			currentTurn: ctx.currentTurn,
		},
		repo: ctx.repo,
		compression: {
			session: {
				tokensIn: ctx.st.originalTokens,
				tokensOut: ctx.st.totalTokenEstimate,
				tokensFreed: ctx.rt.tokensSaved,
				compressionPct: ctx.rt.tokensSaved / Math.max(1, ctx.st.originalTokens),
				dedupPct: ctx.rt.dedupAttempts > 0 ? ctx.rt.dedupSkips / ctx.rt.dedupAttempts : 0,
			},
			repo: {
				tokensIn: ctx.repo.originalTokens,
				tokensOut: ctx.repo.totalTokenEstimate,
				tokensFreed: ctx.repo.tokensSaved,
				compressionPct: ctx.repo.tokensSaved / Math.max(1, ctx.repo.originalTokens),
				dedupPct: ctx.repo.dedupAttempts > 0 ? ctx.repo.dedupCollapsed / ctx.repo.dedupAttempts : 0,
			},
		},
		integrity: ctx.di,
		cacheHits: {
			session: ctx.rt.dedupSkips + ctx.rt.recallInjections,
			// Total = cumulative dedup collapses (meta table) + session
			// recall injections. The meta table is the authoritative
			// cumulative counter for dedup; recall injections are tracked
			// per-session in rt and there's no cumulative counter yet.
			total: ctx.repo.dedupCollapsed,
			sessionTokensSaved: ctx.rt.cacheHitTokens,
			// Cumulative tokens saved across all sessions in this repo —
			// was a placeholder (dedupCollapsed * 100).
			totalTokensSaved: ctx.repo.tokensSaved,
		},
		compacts: {
			session: ctx.rt.compactCount,
			total: ctx.repo.checkpointCount,
		},
		timeSaved: {
			compact: {
				sessionSec: ctx.rt.tokensSaved / 1000,
				totalSec: ctx.repo.tokensSaved / 1000,
			},
			cacheHit: {
				sessionSec: ctx.rt.cacheHitTokens / 1000,
				totalSec: ctx.repo.tokensSaved / 1000,
			},
		},
		model: ctx.currentModel
			? {
				name: ctx.currentModel.modelId,
				provider: ctx.currentModel.provider,
				providerName: ctx.currentModel.providerName ?? ctx.currentModel.provider,
				inputRate: ctx.currentModel.inputRate,
				outputRate: ctx.currentModel.outputRate,
			}
			: undefined,
		diag: {
			ctxFastGate: ctx.diagCtxFastGate,
			liveTrimFires: ctx.diagLiveTrimFires,
			liveTrimReplays: ctx.diagLiveTrimReplays,
		},
		retries: {
			errorRetryCount: ctx.errorRetryCount,
			consecutiveErrors: ctx.consecutiveErrors,
			maxConsecutiveErrors: ctx.ERROR_RETRY_MAX_CONSECUTIVE,
			errorRetryHardStop: ctx.errorRetryHardStop,
			// R7 (retry redesign): additive session-cap + poisoned-context counters.
			sessionRetryCount: ctx.sessionRetryCount,
			sessionMax: ctx.sessionRetryMax,
			poisonedCount: ctx.poisonedCount,
		},
	};
}
