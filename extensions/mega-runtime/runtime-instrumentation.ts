/**
 * runtime-instrumentation.ts — base class holding MegaRuntime's field
 * declarations (diagnostic counters + context-health ring buffers + the Sprint-H
 * internal-error ring + live display/cache-stability state).
 *
 * Extracted from runtime.ts (delegate-shell split) so the MegaRuntime class
 * stays a field-declarations + 1-line-delegate shell. As a base class, the
 * field NAMES are unchanged (`this.diagLiveTrimFires`, `this.trimCache`, etc.) —
 * call sites across the codebase and tests need no edits.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelSnapshot, GameState } from "../../src/store/sqlite.js";
import type { TickerEntry, WidgetData } from "./widget.js";
import type { FSWatcher } from "node:fs";
import { DEFAULT_SAVED_GOAL } from "../mega-config.js";

/**
 * DIAG counters for the "team run doesn't relieve context" investigation.
 * Plain integers, incremented at the three compaction decision points. They
 * let a headless test drive the real event handlers and assert the firing
 * cadence without scraping log files. Inert in production (the live-trim and
 * before-compact probes also emit logger.info, but these counters are always
 * updated and cost nothing).
 */
export class RuntimeInstrumentation {
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
	diagCtxOutputErrorTrip = 0; // Phase H: output-error catch tripped a forced compaction
	diagCtxHeadroomTrip = 0; // v0.21.9: output-headroom gate tripped a pre-overflow compaction
	diagCtxWireTruth = 0; // v0.21.12: a provider 400 text was parsed into ground-truth tokens
	diagCtxSkipCapped = 0; // v0.21.12: the live-trim skip path was tail-capped to fit the budget

	// Context health instrumentation (v0.12): rolling ring buffers for
	// drift detection + cache poison Layer 1 hash baseline.
	recentTurnEmbeddings: number[][] = [];
	recentErrorCategories: (string | null)[] = [];
	lastPrefixHash: string | null = null;
	lastErrorCategory: string | null = null;

	// Sprint H (Finding 3): a SEPARATE internal-error ring fed by explicit
	// `recordInternalError(category)` calls at each store/service-write failure
	// emit site (Option A — NOT a central events.log filter). This captures
	// internal store-write failures which the API-error `errorRate` ring never
	// sees. The health-handler computes a distinct `storeErrorRate` 6th axis.
	// Mirrors `recentErrorCategories` / `lastErrorCategory` exactly (cap = RING_MAX).
	recentInternalErrors: string[] = [];

	/**
	 * S26 capture instrumentation: the "model_snapshots empty → $0.00 cost card"
	 * bug was invisible because captureModel swallowed the DB write in a silent
	 * `catch {}`. These always-updated counters (zero cost) let a headless test or
	 * a live capture tell whether captureModel ran and whether the snapshot landed.
	 */
	diagCaptureModelCalls = 0; // captureModel entered with a populated ctx.model
	diagCaptureModelFails = 0; // recordModelSnapshot threw → model_snapshots stays empty

	// ── Live display / cache-stability state (moved from runtime.ts shell) ────

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
		/** v0.21.9: safety margin % recorded at fire time so the D.2/D.3 replay
		 *  paths can re-cap the replayed tail with the same reserve math. */
		safetyMarginPct: number;
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
	// Seeded from the %-derived DEFAULT_SAVED_GOAL (low-tier fire point at the
	// default context window); resetRuntime re-seeds from the live
	// effectiveThreshold when the window is known. Display-only.
	savedGoal = DEFAULT_SAVED_GOAL;
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
	lastHeartbeatAt: number = 0;
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
}
