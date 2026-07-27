/**
 * runtime.ts — the `MegaRuntime` class: shared live state of the mega-compact
 * extension.
 *
 * Extracted from state.ts so the class lives in its own module.  state.ts
 * re-exports it for backwards compatibility.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { VectorStore } from "../../src/vectorStore.js";
import { toEngineMessages } from "../../src/adapt.js";
import { normalizeSessionId } from "../../src/store.js";
import { Logger } from "../../src/log.js";
import {
	type ModelSnapshot,
	type GameState,
} from "../../src/store/sqlite.js";
import {
	pressureRatio,
	pressureFromPct,
	pressureBand,
	effectiveThresholdTokens,
	type MegaConfig,
	type PressureBand,
} from "../mega-config.js";
import { Dashboard } from "../mega-dashboard.js";
import {
	STATUS_KEY,
	WIDGET_KEY,
	type SessionRuntime,
} from "./helpers.js";
import {
	buildWidgetLines,
	type TickerEntry,
	type WidgetData,
} from "./widget.js";
import { type FSWatcher } from "node:fs";
import {
	ensureGameStateWatcherImpl,
	getCachedGameStateImpl,
	refreshWidgetGameStateImpl,
	bumpGameStateImpl,
} from "./game-state.js";
import {
	setEffectImpl,
	armMegaCacheFlareImpl,
	armAchievementFlareImpl,
	makeTierCallbackImpl,
	pushTickerImpl,
} from "./effects.js";
import { ensurePerfIntervalImpl, disposePerf } from "./perf.js";
import { captureModelImpl } from "./capture-model.js";
import { bindRepoImpl } from "./bind-repo.js";
import { snapshotImpl } from "./runtime-snapshot.js";

export class MegaRuntime {
	config: MegaConfig;
	// Store/dashboard/logger are rebound per-repo by bindRepo() so each git repo
	// gets its own isolated state dir. They start bound to the global default.
	store: VectorStore;
	logger: Logger;
	dashboard: Dashboard;
	activeRepoRoot: string | null = null;
	currentStateDir: string;

	// The only mutable per-session state. Reset on session_start / session_tree.
	rt: SessionRuntime = {
		sessionId: normalizeSessionId(undefined),
		persistedThisSession: false,
		lastCheckpointId: undefined,
		lastCompactedFrom: 0,
		lastCompactedTokens: 0,
		dedupSkips: 0,
		dedupAttempts: 0,
		tokensSaved: 0,
		lastCompactAt: null,
		lastNativeCompactAt: null,
		compactCount: 0,
		recallInjections: 0,
		cacheHitTokens: 0,
		lengthStopPending: false,
		errorRetryCount: 0,
		errorRetryUntil: 0,
		consecutiveErrors: 0,
	};
	// v0.8.6 cache-stability: the cached live-trim view for the current
	// compaction epoch. Set after a fresh runCompact + computeLiveTrimCut, and
	// replayed verbatim on subsequent gated context events in the SAME epoch
	// (same checkpointId) so the provider KV-cache prefix stays stable instead
	// of being invalidated by a freshly regenerated summary + sentinel every
	// fire. Invalidated on session restart (resetRuntime) and on any native
	// durable compaction (session_compact) that truncates the transcript.
	trimCache: {
		checkpointId: string;
		cut: number;
		summaryAgentMsg: AgentMessage;
		ctxPct: number | null;
		ctxTokens: number | null;
	} | null = null;
	debounceUntil = 0;
	// S16: debounce for the agent_end resume nudge (avoid busy-loops).
	resumeNudgeUntil = 0;
	// Agent tracking for real-time widget updates
	activeAgents = 0;
	currentTurn = 0;
	// S33: transient MEGA CACHE flare flag (armed by the turn_end scoring hook
	// when cachePct > 100). Copied into widgetData.megaCacheFlare on the next
	// snapshot() so the widget renders the oopsie gag, then reset (one cycle).
	megaCacheFlare = false;
	/** v0.8.3: ambient effect state for animated panel borders keyed off
	 *  status transitions (level-up, mega-cache overshoot, achievement unlock,
	 *  compaction start). Threaded into widgetData as `activeEffect`; the widget
	 *  computes the per-frame phase from startedAt vs Date.now() (non-expired).
	 *  Null when idle/expired. */
	activeEffect: { type: "pulse" | "flash"; role: "accent" | "mega" | "red"; startedAt: number; durationMs: number } | null = null;
	megaCacheFlarePct = 0;
	levelUpFlare = false;
	lastLevel = 0;
	// S35: transient achievement-unlock flare (armed by the scoring hooks after
	// evaluateAndUnlockAchievements returns newly-unlocked titles). Copied into
	// widgetData.achievementFlare on the next snapshot() so the widget renders the
	// unlock toast, then reset (one cycle — mirrors megaCacheFlare/levelUpFlare).
	achievementFlare = false;
	achievementFlareTitles: string[] = [];
	// S33: last cumulative dedup-collapsed count seen by the session_compact
	// hook, so we only record the DELTA as the dedupe score (leaderboard sums).
	lastDedupCollapsed = 0;
	// Recall block produced by auto-inline (resume/branch) that the next
	// before_agent_start should prepend to the system prompt. Unset after use.
	pendingRecallBlock: string | undefined;
	// S21: memory recall block, parallel to pendingRecallBlock. Same one-shot
	// semantics; composed with the checkpoint block in before_agent_start.
	pendingMemoryRecallBlock: string | undefined;
	statusKey: string | undefined; // current status text for dashboard
	// Active model/provider (for real cost estimation). Captured from ctx.model
	// on model_select + session_start; persisted to SQL so cost + the dashboard
	// can read it without a live ctx.
	currentModel: ModelSnapshot | undefined;
	// Live "what it's doing right now" timestamp, used for the fresh-window.
	lastActivityAt = 0;
	// Live per-tier dedup trace (Phase 1): e.g. "L0 ✓ → L1 ✓ → L2 0.91 → stored".
	// Built from the store's sync onTier callback during a compaction so the user
	// watches each tier evaluate in real time. Cleared once the outcome settles.
	tierTrace: string | undefined;
	// Phase 3 — standout toolbar state.
	// Recall/activity ticker: a small ring buffer (≤5) of recent compact/recall
	// events so the widget shows a live history instead of a single last action.
	ticker: TickerEntry[] = [];
	readonly TICKER_MAX = 5;
	// Pulsing status: set true while a compaction is in flight, cleared on result.
	pulsing = false;
	// S21.2: set by `applyMemoryOps` when a memory add/replace/remove lands in
	// the current compaction. The pipeline reads this after a successful compact
	// to decide whether to fire `consolidateMemories` (skip the work entirely
	// when no memory rows changed).
	memoriesTouchedThisCompaction = 0;
	// Rolling "saved" goal for the progress bar — grows as we save more, so the
	// bar always has a meaningful denominator (never sits at 100% forever).
	savedGoal = 50_000;
	// Last explain-why line (dedup reason / anchor-kept / superseded), surfaced
	// while fresh.
	lastWhy: string | undefined = undefined;
	// v0.8.8 Perf dashboard instrumentation: turn/provider start timestamps +
	// the 5s cpu/mem interval handle (one per MegaRuntime, cleared in dispose()).
	perfTurnStart = 0;
	perfProviderStart = 0;
	perfCpuInterval: ReturnType<typeof setInterval> | null = null;
	perfCpuBaseline: { user: number; sys: number } | undefined;

	// Context tracking for the dashboard (updated in the context handler).
	lastCtxTokens: number | null = null;
	lastCtxPercent: number | null = null;
	lastCtxWindow = 0;

	// Latest computed widget payload (recomputed per snapshot, rendered per frame).
	widgetData: WidgetData | null = null;
	// v0.8.5: material-change signature from the last full snapshot() body. When
	// the next snapshot()'s signature matches, the expensive recompute (6 sync
	// SQLite opens) + writeFileSync(dashboard.json) are skipped — only the
	// (already-registered) widget factory is refreshed. Kills the per-event
	// main-thread block during typing/idle streaming with no material change.
	lastSnapshotSig: string | null = null;
	// v0.8.5: bumped whenever the cached game-state memo is evicted (bumpGameState
	// for in-process /mega-game writes, the fs.watch callback for cross-process
	// dashboard-server writes, and bindRepo on repo switch) so the snapshot gate
	// invalidates and the widget re-reads theme/mode after the change.
	gameStateBump = 0;
	// Cached cross-repo drift status (recomputed at most every 30s — it opens the
	// machine-wide registry DB, so we don't want to do it on every render frame).
	driftCache: { at: number; status: "ok" | "warn" } | null = null;
	// S31: cached game-mode state (game_mode_on/theme/tui_display_mode). Lazily
	// read from the game_state SQLite row on the first widget render, then
	// memoized until bumpGameState() evicts it (called by /mega-game after a
	// write) so the widget picks up theme/mode/level changes live without
	// re-querying the DB on every render frame.
	cachedGameState: GameState | undefined;
	// S32: fs.watch on the current repo's sqlite.db so cross-process writes
	// (e.g. the dashboard server's PUT /api/game-state, which runs as a detached
	// child with no MegaRuntime ref) evict the cached game-state memo. Without
	// this, /mega-game's in-process bumpGameState() is the only eviction trigger
	// and the widget would keep showing stale theme/mode/toggle after a dashboard
	// edit until a restart. The watcher tracks currentStateDir — closed + re-opened
	// by ensureGameStateWatcher() on every bindRepo repo switch. Non-fatal: any
	// fs.watch failure (missing file / platform issue) is swallowed; the next
	// getCachedGameState() snapshot re-queries the DB anyway.
	gameStateWatcher?: FSWatcher;
	gameStateWatchDir?: string;
	// P2: the last ExtensionContext handed to snapshot()/renderWidget(), stashed
	// so the fs.watch game-state callback can force a widget re-render without
	// a context event (cross-process dashboard edits while pi is idle). Cleared
	// implicitly on construction (undefined → watcher skips until first snap).
	lastWidgetCtx?: ExtensionContext;

	/**
	 * DIAG counters for the "team run doesn't relieve context" investigation.
	 * Plain integers, incremented at the three compaction decision points. They
	 * let a headless test drive the real event handlers and assert the firing
	 * cadence without scraping log files. Inert in production (the live-trim and
	 * before-compact probes also emit logger.info, but these counters are always
	 * updated and cost nothing).
	 */
	diagLiveTrimFires = 0; // context handler returned a trimmed view
	diagLiveTrimReplays = 0; // v0.8.6: trim view returned via cached replay (skipped re-compact)
	diagBeforeCompactFires = 0; // session_before_compact handler entered
	diagBeforeCompactSupplied = 0; // session_before_compact supplied our trim
	diagAgentEndIdle = 0; // agent_end with activeAgents===0
	diagAgentEndDurable = 0; // agent_end fired ctx.compact() (mid-run durable trim)
	diagAgentEndDurableSkipRecent = 0; // agent_end skipped ctx.compact() — compaction in last 10s (race guard)
	// Per-skip-path counters for the team-run diagnosis.
	diagCtxFastGate = 0; // returned at token fast-gate (below threshold)
	diagCtxNoCompact = 0; // autoCompactCheck().shouldCompact === false
	diagCtxDebounce = 0; // debounceUntil not yet elapsed
	diagCtxRunSkipped = 0; // runCompact() returned skipped
	diagCtxCutNull = 0; // computeLiveTrimCut returned null (anchor/boundary)
	diagCtxThrown = 0; // live-trim try threw (caught)

	/**
	 * S26 capture instrumentation: the "model_snapshots empty → $0.00 cost card"
	 * bug was invisible because captureModel swallowed the DB write in a silent
	 * `catch {}`. These always-updated counters (zero cost) let a headless test or
	 * a live capture tell whether captureModel ran and whether the snapshot landed.
	 */
	diagCaptureModelCalls = 0; // captureModel entered with a populated ctx.model
	diagCaptureModelFails = 0; // recordModelSnapshot threw → model_snapshots stays empty

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
	get pressure(): number {
		if (
			this.lastCtxWindow > 0 &&
			this.config.tierPct != null &&
			this.lastCtxPercent != null
		) {
			// pressureFromPct(x) = x/100, and x = lastCtxPercent/tierPct, so this is
			// exactly the intended lastCtxPercent/(tierPct*100) 0–1 ratio: at the
			// fire point (lastCtxPercent == tierPct*100) pressure == 1.0, matching the
			// token-based pressureRatio(currentTokens, effectiveThreshold) reading so
			// the band doesn't jump when a token-count vs percent-only event arrives.
			return pressureFromPct(this.lastCtxPercent / this.config.tierPct);
		}
		if (
			this.lastCtxTokens != null &&
			this.lastCtxTokens > 0 &&
			this.config.thresholdTokens > 0
		) {
			return pressureRatio(this.lastCtxTokens, this.config.thresholdTokens);
		}
		return pressureFromPct(this.lastCtxPercent);
	}

	/**
	 * The live compaction FIRE POINT in tokens: the effective threshold scaled by
	 * the current model context window (`tierPct * window`) when known, else the
	 * boot fallback `config.thresholdTokens`. This is what the FAST GATE /
	 * `autoCompactCheck` / agent_end durable-trigger compare against, so
	 * compaction fires at tier% of the window for ANY model size (200k or 1M),
	 * always below pi's native auto-compaction (~80% of window).
	 */
	get effectiveThreshold(): number {
		return effectiveThresholdTokens({
			tierPct: this.config.tierPct,
			fallbackThreshold: this.config.thresholdTokens,
			window: this.lastCtxWindow,
		});
	}

	/** Live discrete pressure band (low/medium/high/ultra/mega) over `pressure`. */
	get pressureBand(): PressureBand {
		return pressureBand(this.pressure);
	}

	constructor(config: MegaConfig) {
		this.config = config;
		this.store = new VectorStore({
			dedupSim: config.dedupSim,
			stateDir: config.stateDir,
		});
		this.logger = new Logger({
			enabled: config.debug,
			path: join(config.stateDir, "mega-compact.log"),
		});
		this.dashboard = new Dashboard(config.stateDir);
		this.currentStateDir = config.stateDir;
		this.ensureGameStateWatcher();
	}

	// ---- per-repo binding -----------------------------------------------------

	bindRepo(cwd: string | undefined): string {
		return bindRepoImpl(this, cwd);
	}

	// ---- dashboard snapshot + widget ------------------------------------------

	/** Collect live state and write it to disk (+ paint the above-editor widget). */
	snapshot(ctx?: ExtensionContext): void {
		snapshotImpl(this, ctx);
	}

	/** Register the above-editor widget as a width-aware factory so pi re-renders
	 *  it at the REAL terminal width every frame (auto-fit wide/narrow). The
	 *  factory returns a minimal Component whose render() reads this.widgetData.
	 */
	renderWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, _theme) => ({
				render: (width: number) =>
					buildWidgetLines(
						this.widgetData,
						width > 0 ? width : 200,
						this.activeAgents,
					),
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	setStatus(ctx: ExtensionContext, text: string | undefined): void {
		this.statusKey = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	resetRuntime(sessionId: string | undefined): void {
		const sid = normalizeSessionId(sessionId);
		if (this.rt.sessionId === sid && this.rt.persistedThisSession) return; // same session, keep checkpoint memory
		this.rt = {
			sessionId: sid,
			persistedThisSession: false,
			lastCheckpointId: undefined,
			lastCompactedFrom: 0,
			lastCompactedTokens: 0,
			dedupSkips: 0,
			dedupAttempts: 0,
			tokensSaved: 0,
			lastCompactAt: null,
			lastNativeCompactAt: null,
			compactCount: 0,
			recallInjections: 0,
			cacheHitTokens: 0,
			lengthStopPending: false,
			errorRetryCount: 0,
			errorRetryUntil: 0,
			consecutiveErrors: 0,
	};
	this.trimCache = null; // v0.8.6: never replay a stale trim into a new session
		this.statusKey = undefined;
		this.activeAgents = 0;
		this.currentTurn = 0;
		this.lastActivityAt = 0;
		this.tierTrace = undefined;
		this.ticker.length = 0;
		this.pulsing = false;
		this.savedGoal = 50_000;
		this.lastWhy = undefined;
		// S31 audit P2: symmetry with bindRepo — a reset can coincide with a context
		// that re-binds the repo, so drop the memo too. Cheap; the next
		// getCachedGameState() re-queries lazily.
		this.cachedGameState = undefined;
	}

	captureModel(ctx: ExtensionContext): void {
		captureModelImpl(this, ctx);
	}

	/**
	 * Append a structured line to the repo's events.log — the always-on
	 * diagnostics sink the dashboard live-streams. Unlike this.logger (gated by
	 * config.debug), this fires in production, so capture failures surface during
	 * a real capture even with debugging off. Best-effort + non-fatal.
	 */
	appendEvent(event: string, fields: Record<string, unknown>): void {
		try {
			mkdirSync(this.currentStateDir, { recursive: true });
			appendFileSync(
				join(this.currentStateDir, "events.log"),
				JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n",
			);
		} catch {
			/* non-fatal */
		}
	}

	/** S21: state dir of the currently bound repo (where memories live). */
	getStateDir(): string {
		return this.currentStateDir;
	}

	/** S32: (re)target the fs.watch cache-eviction watcher at the current
	 *  stateDir's sqlite.db. Called from the constructor + every bindRepo repo
	 *  switch so the watcher always tracks the NEW repo's db file. If a watcher
	 *  already exists for this dir, no-op; if the dir changed, close the old one
	 *  first. fs.watch can throw on a missing file / platform issues — wrapped
	 *  non-fatal; the next getCachedGameState() re-queries the DB anyway. */
	ensureGameStateWatcher(): void {
		ensureGameStateWatcherImpl(this, this);
	}

	/** S32: release the fs.watch game-state watcher. Called when the runtime is
	 *  torn down (no existing dispose path — the process exit reclaims the fd,
	 *  but explicit close is correct for any in-process reload / test reuse). */
	dispose(): void {
		if (this.gameStateWatcher) {
			try { this.gameStateWatcher.close(); } catch { /* non-fatal */ }
			this.gameStateWatcher = undefined;
			this.gameStateWatchDir = undefined;
		}
		disposePerf(this);
	}

	ensurePerfInterval(): void {
		ensurePerfIntervalImpl(this);
	}

	/** S31: the cached game-mode state (game_mode_on/theme/tui_display_mode).
	 *  Lazily read from the game_state SQLite row on the first call, then
	 *  memoized until `bumpGameState()` evicts it. Reading is non-throwing
	 *  (getGameState returns DEFAULT_GAME_STATE on any error), so the widget
	 *  can call this on every render safely. */
	getCachedGameState(): GameState {
		return getCachedGameStateImpl(this);
	}

	/** P2 cross-process re-render: lightweight game-state refresh for the
	 *  fs.watch callback. Eviction of cachedGameState + gameStateBump++ happens
	 *  in the caller BEFORE this runs. Here we re-read ONLY the game_state row
	 *  via getCachedGameState() (one SELECT; the cache is already evicted) and
	 *  patch ONLY the three game-mode fields on the EXISTING widgetData, then
	 *  re-register the widget factory via renderWidget() so pi redraws next
	 *  frame.
	 *
	 *  WHY a lightweight path: the full snapshot(ctx) recomputes 6 synchronous
	 *  SQLite opens + writeFileSync(dashboard.json) + store writes, and those
	 *  store writes RETRIGGER this same fs.watch callback → re-entrant thrash
	 *  (the watcher fires on every sqlite.db* write, including context-event
	 *  checkpoint writes) → 190s test timeout under mega-compact.test.js /
	 *  mega-teamrun.test.js. This path writes NOTHING to the store or
	 *  dashboard.json, so it cannot retrigger itself.
	 *
	 *  Guard: no-op when widgetData is null (no snapshot has run yet → nothing
	 *  to patch) or ctx is undefined. Field values mirror snapshot() exactly. */
	refreshWidgetGameState(ctx: ExtensionContext): void {
		refreshWidgetGameStateImpl(this, this, ctx);
	}

	/** S31: evict the cached game-mode state so the next widget render re-reads
	 *  the game_state row. Called by /mega-game after every setGameState() so
	 *  the panel picks up theme/mode/toggle changes live. */
	bumpGameState(): void {
		bumpGameStateImpl(this);
	}

	armMegaCacheFlare(peakPct: number): void {
		armMegaCacheFlareImpl(this, peakPct);
	}

	armAchievementFlare(titles: string[]): void {
		armAchievementFlareImpl(this, titles);
	}

	setEffect(
		type: "pulse" | "flash",
		role: "accent" | "mega" | "red",
		durationMs: number,
	): void {
		setEffectImpl(this, type, role, durationMs);
	}

	makeTierCallback(
		ctx: ExtensionContext,
	): (ev: {
		tier: "L0" | "L1" | "L2" | "new";
		status: "scanning" | "deduped" | "passed" | "stored";
		detail?: string;
	}) => void {
		return makeTierCallbackImpl(this, ctx);
	}

	pushTicker(text: string): void {
		pushTickerImpl(this, text);
	}

	/** Convert the messages pi hands us in the `context` event into the engine view. */
	engineView(messages: AgentMessage[]): ReturnType<typeof toEngineMessages> {
		return toEngineMessages(messages);
	}
}
