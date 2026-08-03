/**
 * runtime-snapshot.ts — extracted `MegaRuntime.snapshot()` orchestration.
 *
 * The snapshot() body (dashboard write + S39 heartbeat + widget-data compute
 * + flare/effect consumption + perf recording + the v0.8.5 material-change
 * gate) is moved here verbatim. `MegaRuntime.snapshot()` becomes a thin
 * delegate (`snapshotImpl(this, ctx)`), so the public method and every call
 * site is unchanged.
 *
 * Follows the same context-interface + free-function + thin-delegate pattern
 * as effects.ts / game-state.ts / capture-model.ts / runtime-helpers.ts.
 * The pure widget-data computation lives in snapshot.ts (`computeMegaSnapshot`);
 * this module is the orchestration that calls it. The pure/instance helpers
 * materialSig/embedderName/driftStatus/getTurnLevel are called directly via
 * their `*Impl` functions (imported from runtime-helpers.ts) — they were only
 * ever called from snapshot(), so the in-class private delegates are removed
 * from runtime.ts (dead code) rather than kept.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	type VectorStore,
	vectorStats,
	vectorRepoStats,
	vectorDataInvariant,
} from "../../src/vectorStore.js";
import {
	latestModelSnapshot,
	readLatestCacheHitPct,
	recordPerfSample,
	recordSessionHeartbeat,
	appendTokenSample,
	type GameState,
} from "../../src/store/sqlite.js";
import {
	resolveRepoRoot,
	type MegaConfig,
	type PressureBand,
} from "../mega-config.js";
import type { Dashboard } from "../mega-dashboard.js";
import type { WidgetData } from "./widget.js";
import { computeMegaSnapshot } from "./snapshot.js";
import { buildDashboardSnapshot } from "./dashboard-snapshot.js";
import {
	type RuntimeHelpersContext,
	materialSigImpl,
	embedderNameImpl,
	driftStatusImpl,
	getTurnLevelImpl,
} from "./runtime-helpers.js";

// ---------------------------------------------------------------------- types

/**
 * The slice of `MegaRuntime` the snapshot orchestration reads + writes.
 * Extends `RuntimeHelpersContext` (the fields materialSig/driftStatus/
 * getTurnLevel read) so `self` can be passed straight to those `*Impl`
 * functions. `MegaRuntime` satisfies this structurally once `lastSnapshotSig`
 * is public — the same one-token visibility change Phase 2b made for
 * `driftCache` (internal state, not an API contract).
 */
export interface RuntimeSnapshotContext extends RuntimeHelpersContext {
	// ── owned state ──
	store: VectorStore;
	config: MegaConfig;
	dashboard: Dashboard;
	currentStateDir: string;
	widgetData: WidgetData | null;
	/** v0.8.5: material-change signature; read + written by snapshot(). Public so
	 *  the extracted orchestration can reach it (internal state, not an API). */
	lastSnapshotSig: string | null;
	lastWidgetCtx?: ExtensionContext;
	lastActivityAt: number;
	/** Timestamp (ms) of the last session heartbeat write. Used by the
	 *  material-change gate fast path to refresh heartbeats on a cadence. */
	lastHeartbeatAt: number;
	lastLevel: number;
	diagCtxFastGate: number;
	diagLiveTrimFires: number;
	diagLiveTrimReplays: number;

	// ── public methods the orchestration calls ──
	bindRepo(cwd: string | undefined): string;
	renderWidget(ctx: ExtensionContext): void;
	getCachedGameState(): GameState;
	setEffect(
		type: "pulse" | "flash",
		role: "accent" | "mega" | "red",
		durationMs: number,
	): void;

	// ── public getters ──
	readonly pressureBand: PressureBand;
	readonly pressure: number;
	readonly effectiveThreshold: number;
}

// -------------------------------------------------------------- snapshotImpl

/** Collect live state and write it to disk (+ paint the above-editor widget).
 *  Extracted verbatim from `MegaRuntime.snapshot()` (runtime.ts); the public
 *  method there is now `snapshotImpl(this, ctx)`. */
export function snapshotImpl(
	self: RuntimeSnapshotContext,
	ctx?: ExtensionContext,
): void {
	if (ctx) self.lastWidgetCtx = ctx;
	if (ctx) self.bindRepo(ctx.cwd);
	// v0.8.5: gate the expensive body (6 sync SQLite opens +
	// writeFileSync(dashboard.json)) behind a cheap material-change signature.
	// During typing / idle / no-compaction streaming, the 'context' event
	// fires repeatedly with NO material change — skip the recompute + write and
	// just re-register the (live) widget factory, which reads the cached
	// widgetData every frame. This removes the per-event main-thread block
	// WITHOUT changing write timing, so tests that read dashboard.json
	// synchronously after a compaction still see it written (compaction changes
	// compactCount/tokensSaved → the signature changes → the full recompute +
	// write runs).
	const sig = materialSigImpl(self);
	if (ctx && self.widgetData && self.lastSnapshotSig === sig) {
		self.renderWidget(ctx);
		// Refresh heartbeat on a time cadence even when material state hasn't
		// changed, so the session doesn't appear stale and get pruned by the
		// dashboard's 30-min cutoff. The full snapshot recompute is still gated
		// (expensive SQLite opens + writeFileSync), but a heartbeat row is
		// cheap (single INSERT OR REPLACE on the index DB).
		refreshHeartbeatIfStale(self, ctx, 10_000);
		return;
	}
	const perfT0 = performance.now();
	const st = vectorStats(self.store, self.rt.sessionId);
	const repo = vectorRepoStats(self.store);
	const di = vectorDataInvariant(self.store);
	// Effective threshold + armed/ready status for the dashboard.
	// effectiveThresholdPct: the live fire point as a % of the window (null for
	// `custom`, which has no tierPct). S29: honors MEGACOMPACT_AUTO_PCT_TRIGGER
	// override so the dashboard's armed/ready match the context-handler gate
	// (which fires on this same %). Used by armed/ready + the dashboard.
	const effectiveThresholdPct =
		self.config.tierPct != null
			? (self.config.autoPctTrigger ?? self.config.tierPct) * 100
			: null;
	// armed lights at/above the REAL fire point: max(effectiveThresholdPct,
	// fastGatePct). fastGatePct already equals tierPct*100 by default, but a
	// MEGACOMPACT_FAST_GATE_PCT override can raise it, so we take the max.
	const armed =
		self.lastCtxPercent != null &&
		self.lastCtxPercent >=
			Math.max(effectiveThresholdPct ?? 0, self.config.fastGatePct);
	// S29: ready mirrors the context-handler gate's basis — percent for tiered
	// (the gate fires on pct), tokens for custom (the gate fires on tokens).
	// Previously this always required tokens, so the dashboard could show
	// "armed" (percent high) but never "ready" when tokens were under-reported
	// — the same inconsistency the S29 gate fix removes.
	const ready =
		self.config.tierPct != null
			? armed && (self.lastCtxPercent ?? 0) >= (effectiveThresholdPct ?? 0)
			: armed && (self.lastCtxTokens ?? 0) >= self.effectiveThreshold;
	self.dashboard.snapshot(
		buildDashboardSnapshot({
			config: self.config,
			rt: self.rt,
			pressureBand: self.pressureBand,
			pressure: self.pressure,
			effectiveThreshold: self.effectiveThreshold,
			statusKey: self.statusKey,
			lastCtxTokens: self.lastCtxTokens,
			lastCtxPercent: self.lastCtxPercent,
			lastCtxWindow: self.lastCtxWindow,
			diagCtxFastGate: self.diagCtxFastGate,
			diagLiveTrimFires: self.diagLiveTrimFires,
			diagLiveTrimReplays: self.diagLiveTrimReplays,
			errorRetryCount: self.rt.errorRetryCount,
			consecutiveErrors: self.rt.consecutiveErrors,
			ERROR_RETRY_MAX_CONSECUTIVE: self.config.maxConsecutiveErrors,
			errorRetryHardStop: self.config.errorRetryHardStop,
			// R7 (retry redesign): session-cap + poisoned-context counters.
			sessionRetryCount: self.rt.errorRetrySessionCount,
			sessionRetryMax: self.config.errorRetrySessionMax,
			poisonedCount: self.rt.poisonedCount,
			activeAgents: self.activeAgents,
			currentTurn: self.currentTurn,
			currentModel: self.currentModel,
			st,
			repo,
			di,
		}),
	);
	const perfDiskMs = self.dashboard.lastWriteMs;

	// S39: record a session heartbeat + token sample into the shared
	// machine-wide index.sqlite so the dashboard can show a real-time
	// stacked-memory graph across all active pi processes. Behind the
	// material-change gate (this code only runs when sig changed). Non-fatal
	// try/catch mirrors the recordPerfSample pattern below. Skip the token
	// sample when lastCtxTokens is null (no context data yet).
	try {
		const repo =
			resolveRepoRoot(ctx?.cwd ?? self.currentStateDir) ?? self.currentStateDir;
		recordSessionHeartbeat(
			process.pid,
			self.rt.sessionId,
			repo,
			self.currentStateDir,
			self.lastCtxWindow || 0,
		);
		if (self.lastCtxTokens != null) {
			appendTokenSample(
				self.rt.sessionId,
				repo,
				self.lastCtxTokens,
				self.lastCtxPercent ?? 0,
				self.lastCtxWindow || 0,
				join(self.currentStateDir, "events.log"),
			);
		}
	} catch {
		/* non-fatal: S39 monitoring must never block the snapshot path */
	}

	// Live stats widget above the editor
	if (ctx) {
		// S31: game-mode state — fetched before the widget computation so the
		// pure function gets a plain value rather than another callback.
		const gs = self.getCachedGameState();
		// S34: derive the level-up flare from the turn count. This side-effect
		// check must happen BEFORE computeMegaSnapshot so the flare and the
		// ambient effect are armed for the current frame.
		const curLevel = getTurnLevelImpl(self);
		if (curLevel > self.lastLevel) {
			self.levelUpFlare = true;
			// v0.8.3: arm a pulse border effect to celebrate the level-up.
			self.setEffect("pulse", "accent", 1500);
		}
		// ── gather widget data (computed per snapshot, rendered per frame) ────
		const modelSnap = latestModelSnapshot(self.currentStateDir);
		// Provider prompt cache hit % for the widget (B/C): latest
		// cache_hit_pct sample. Non-fatal — one extra sync open per
		// material-change-gated recompute, acceptably cheap.
		let providerCachePct = 0;
		try {
			providerCachePct = readLatestCacheHitPct(self.currentStateDir);
		} catch {
			/* non-fatal */
		}
		const _snapResult = computeMegaSnapshot({
			lastCtxTokens: self.lastCtxTokens,
			lastCtxWindow: self.lastCtxWindow,
			lastCtxPercent: self.lastCtxPercent,
			activeAgents: self.activeAgents,
			currentTurn: self.currentTurn,
			statusKey: self.statusKey,
			st,
			repo,
			rtTokensSaved: self.rt.tokensSaved,
			lastCompactAt: self.rt.lastCompactAt,
			ticker: self.ticker,
			lastWhy: self.lastWhy,
			tierTrace: self.tierTrace,
			pulsing: self.pulsing,
			getCachedGameState: () => gs,
			getTurnLevel: () => getTurnLevelImpl(self),
			embedderName: () => embedderNameImpl(),
			driftStatus: () => driftStatusImpl(self),
			megaCacheFlare: self.megaCacheFlare,
			megaCacheFlarePct: self.megaCacheFlarePct,
			levelUpFlare: self.levelUpFlare,
			achievementFlare: self.achievementFlare,
			achievementFlareTitles: self.achievementFlareTitles,
			activeEffect: self.activeEffect,
			lastActivityAt: self.lastActivityAt,
			pressureBand: self.pressureBand,
			configTier: self.config.tier,
			ready,
			armed,
			modelSnap,
			providerCachePct,
			perTurnCacheHitPct: self.rt._prevCacheHitPct ?? undefined,
		});
		self.widgetData = _snapResult.widgetData;
		// S33: consume the flare after copying it into widgetData so it fires
		// for exactly one render cycle (the gag flares once, then clears).
		self.megaCacheFlare = false;
		self.megaCacheFlarePct = 0;

		// S34: consume the level-up flare after one render cycle (mirrors the
		// megaCacheFlare one-shot semantics), and advance lastLevel.
		self.levelUpFlare = false;
		self.lastLevel = curLevel;
		// S35: consume the achievement-unlock flare after one render cycle
		// (mirrors the megaCacheFlare/levelUpFlare one-shot semantics).
		self.achievementFlare = false;
		self.achievementFlareTitles = [];
		// v0.8.3: expire the ambient border effect once its time window has
		// elapsed. SEPARATE from the one-shot flares above (those are per-cycle
		// consumes; activeEffect is time-windowed and cleared when Date.now()
		// crosses startedAt + durationMs). The widget also defends this per-frame
		// (effectBorderSgr returns '' once expired), so this is bookkeeping to
		// free the slot and prevent a stale effect lingering between snapshots.
		if (
			self.activeEffect &&
			Date.now() - self.activeEffect.startedAt >= self.activeEffect.durationMs
		) {
			self.activeEffect = null;
		}
		// Auto-fit: register a factory so pi re-renders the panel at the REAL
		// terminal width every frame (tui.columns), instead of guessing with
		// process.stdout.columns. buildWidgetLines reads this.widgetData live.
		self.renderWidget(ctx);
	}
	// v0.8.5: record the material-change signature computed at the top so the
	// next snapshot() can skip this whole body when nothing material changed.
	try {
		recordPerfSample(
			self.currentStateDir,
			"db_recompute_ms",
			performance.now() - perfT0,
		);
		recordPerfSample(self.currentStateDir, "disk_write_ms", perfDiskMs);
	} catch {
		/* non-fatal: perf instrumentation never blocks the agent */
	}
	self.lastSnapshotSig = sig;
	self.lastHeartbeatAt = Date.now();
}

// ----------------------------------------------------------- heartbeat refresh

/** Refresh the session heartbeat if enough time has elapsed since the last
 *  write. Called from the material-change gate fast path (where the full
 *  snapshot recompute is skipped) so the session stays visible in the
 *  dashboard during idle/typing periods. Non-fatal — best-effort like the
 *  main heartbeat write. */
function refreshHeartbeatIfStale(
	self: RuntimeSnapshotContext,
	ctx: ExtensionContext | undefined,
	intervalMs: number,
): void {
	const now = Date.now();
	if (now - self.lastHeartbeatAt < intervalMs) return;
	try {
		const repo =
			resolveRepoRoot(ctx?.cwd ?? self.currentStateDir) ?? self.currentStateDir;
		recordSessionHeartbeat(
			process.pid,
			self.rt.sessionId,
			repo,
			self.currentStateDir,
			self.lastCtxWindow || 0,
		);
		self.lastHeartbeatAt = now;
	} catch {
		/* non-fatal: heartbeat refresh must never block the snapshot path */
	}
}
