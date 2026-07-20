/**
 * state.ts — the `MegaRuntime` class: shared live state of the mega-compact
 * extension.
 *
 * The original mega-compact.ts was a single large closure over ~20 mutable
 * variables. This module lifts that state into a `MegaRuntime` class so the
 * event/command/pipeline modules can share it without re-declaring it. All
 * behavior (store/dashboard rebinding, dashboard snapshot shape, the
 * above-editor widget math, model capture) is preserved byte-for-byte from the
 * original closure.
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
	recordModelSnapshot,
	latestModelSnapshot,
	upsertRepoRegistry,
	recordRepoModel,
	getDedupStats,
	getCompactCount,
	getRecallInjected,
	getCacheHitTokensSaved,
	getGameState,
	type ModelSnapshot,
	type GameState,
} from "../../src/store/sqlite.js";
import { detectCrossRepoDrift } from "../../src/driftDetection.js";
import {
	repoStateDir,
	resolveRepoRoot,
	pressureRatio,
	pressureFromPct,
	pressureBand,
	effectiveThresholdTokens,
	type MegaConfig,
	type PressureBand,
} from "../mega-config.js";
import { Dashboard, type DashboardSnapshot } from "../mega-dashboard.js";
import {
	STATUS_KEY,
	WIDGET_KEY,
	TOKENS_PER_SEC_ESTIMATE,
	ownVersion,
	type SessionRuntime,
} from "./helpers.js";
import {
	C,
	buildWidgetLines,
	type TickerEntry,
	type WidgetData,
} from "./widget.js";
import { getTheme } from "../../src/config/themes.js";
import { watch, type FSWatcher } from "node:fs";
import { turnLevel } from "../../src/game/scoring.js";

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
	};
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
	private lastSnapshotSig: string | null = null;
	// v0.8.5: bumped whenever the cached game-state memo is evicted (bumpGameState
	// for in-process /mega-game writes, the fs.watch callback for cross-process
	// dashboard-server writes, and bindRepo on repo switch) so the snapshot gate
	// invalidates and the widget re-reads theme/mode after the change.
	private gameStateBump = 0;
	// Cached cross-repo drift status (recomputed at most every 30s — it opens the
	// machine-wide registry DB, so we don't want to do it on every render frame).
	private driftCache: { at: number; status: "ok" | "warn" } | null = null;
	// S31: cached game-mode state (game_mode_on/theme/tui_display_mode). Lazily
	// read from the game_state SQLite row on the first widget render, then
	// memoized until bumpGameState() evicts it (called by /mega-game after a
	// write) so the widget picks up theme/mode/level changes live without
	// re-querying the DB on every render frame.
	private cachedGameState: GameState | undefined;
	// S32: fs.watch on the current repo's sqlite.db so cross-process writes
	// (e.g. the dashboard server's PUT /api/game-state, which runs as a detached
	// child with no MegaRuntime ref) evict the cached game-state memo. Without
	// this, /mega-game's in-process bumpGameState() is the only eviction trigger
	// and the widget would keep showing stale theme/mode/toggle after a dashboard
	// edit until a restart. The watcher tracks currentStateDir — closed + re-opened
	// by ensureGameStateWatcher() on every bindRepo repo switch. Non-fatal: any
	// fs.watch failure (missing file / platform issue) is swallowed; the next
	// getCachedGameState() snapshot re-queries the DB anyway.
	private gameStateWatcher?: FSWatcher;
	private gameStateWatchDir?: string;

	/**
	 * DIAG counters for the "team run doesn't relieve context" investigation.
	 * Plain integers, incremented at the three compaction decision points. They
	 * let a headless test drive the real event handlers and assert the firing
	 * cadence without scraping log files. Inert in production (the live-trim and
	 * before-compact probes also emit logger.info, but these counters are always
	 * updated and cost nothing).
	 */
	diagLiveTrimFires = 0; // context handler returned a trimmed view
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

	/**
	 * Point store/dashboard/logger at the current repo's state dir. Rebuilds the
	 * instances only when the repo root changes, so cross-repo dedup stats, db,
	 * and events are fully isolated. Falls back to the global default outside git.
	 */
	bindRepo(cwd: string | undefined): string {
		const dir = cwd
			? repoStateDir(cwd, this.config.stateDir)
			: this.config.stateDir;
		const key = cwd ? (resolveRepoRoot(cwd) ?? dir) : dir;
		if (key === this.activeRepoRoot) return dir;
		this.activeRepoRoot = key;
		this.currentStateDir = dir;
		// S31 audit P2: bindRepo switched currentStateDir but left cachedGameState
		// memoized -> the widget kept showing the previous repo's theme/mode/toggle
		// until /mega-game or a restart. The game_state row is per-repo (per
		// stateDir), so evict the memo on every repo switch; the next widget render
		// re-queries lazily via getCachedGameState().
		this.cachedGameState = undefined;
		this.gameStateBump++;
		// S32: re-target the fs.watch cache-eviction watcher at the NEW stateDir's
		// sqlite.db so cross-process writes (dashboard server) still evict the memo.
		this.ensureGameStateWatcher();
		this.store = new VectorStore({
			dedupSim: this.config.dedupSim,
			stateDir: dir,
		});
		this.logger = new Logger({
			enabled: this.config.debug,
			path: join(dir, "mega-compact.log"),
		});
		this.dashboard = new Dashboard(dir);
		// Aggregate this repo into the machine-wide index so the multi-repo
		// dashboard (Summary / All-repos tabs) can show it alongside every other
		// repo. Best-effort + non-fatal: a read-only index dir or contention must
		// never break the per-repo compaction path. Runs only on repo-switch
		// (this branch), so it's infrequent — not per-context-event.
		try {
			const repo = this.store.repoStats();
			const di = this.store.dataInvariant();
			const root = key !== dir ? key : (resolveRepoRoot(cwd ?? dir) ?? dir);
			upsertRepoRegistry({
				repoRoot: root,
				displayName: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
				stateDir: dir,
				checkpointCount: repo.checkpointCount,
				tokensSaved: repo.tokensSaved,
				compressedOriginalBytes: di.compressedOriginalBytes,
			});
		} catch {
			/* non-fatal: index aggregation must not block compaction */
		}
		return dir;
	}

	// ---- dashboard snapshot + widget ------------------------------------------

	/** Collect live state and write it to disk (+ paint the above-editor widget). */
	snapshot(ctx?: ExtensionContext): void {
		if (ctx) this.bindRepo(ctx.cwd);
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
		const sig = this.materialSig();
		if (ctx && this.widgetData && this.lastSnapshotSig === sig) {
			this.renderWidget(ctx);
			return;
		}
		const st = this.store.stats(this.rt.sessionId);
		const repo = this.store.repoStats();
		const di = this.store.dataInvariant();
		// Live + store-wide cache-hit / compaction counters for the dashboard.
		const ds = getDedupStats(this.currentStateDir);
		const cacheHitsTotal = ds.deduped + getRecallInjected(this.currentStateDir);
		const cacheHitsTotalTokens = getCacheHitTokensSaved(this.currentStateDir);
		const cacheHitsSession = this.rt.dedupSkips + this.rt.recallInjections;
		const sec = (tok: number) => (tok || 0) / TOKENS_PER_SEC_ESTIMATE;
		// Active model/provider for the current-repo card + the multi-repo table.
		const modelSnap = latestModelSnapshot(this.currentStateDir);
		const model = modelSnap
			? {
					name: modelSnap.modelName ?? modelSnap.modelId,
					provider: modelSnap.provider,
					providerName: modelSnap.providerName ?? "",
					inputRate: modelSnap.inputRate,
					outputRate: modelSnap.outputRate,
				}
			: undefined;
		// effectiveThresholdPct: the live fire point as a % of the window (null for
		// `custom`, which has no tierPct). S29: honors MEGACOMPACT_AUTO_PCT_TRIGGER
		// override so the dashboard's armed/ready match the context-handler gate
		// (which fires on this same %). Used by armed/ready + the dashboard.
		const effectiveThresholdPct =
			this.config.tierPct != null
				? (this.config.autoPctTrigger ?? this.config.tierPct) * 100
				: null;
		// armed lights at/above the REAL fire point: max(effectiveThresholdPct,
		// fastGatePct). fastGatePct already equals tierPct*100 by default, but a
		// MEGACOMPACT_FAST_GATE_PCT override can raise it, so we take the max.
		const armed =
			this.lastCtxPercent != null &&
			this.lastCtxPercent >=
				Math.max(effectiveThresholdPct ?? 0, this.config.fastGatePct);
		// S29: ready mirrors the context-handler gate's basis — percent for tiered
		// (the gate fires on pct), tokens for custom (the gate fires on tokens).
		// Previously this always required tokens, so the dashboard could show
		// "armed" (percent high) but never "ready" when tokens were under-reported
		// — the same inconsistency the S29 gate fix removes.
		const ready =
			this.config.tierPct != null
				? armed && (this.lastCtxPercent ?? 0) >= (effectiveThresholdPct ?? 0)
				: armed && (this.lastCtxTokens ?? 0) >= this.effectiveThreshold;
		this.dashboard.snapshot({
			version: 1,
			updatedAt: new Date().toISOString(),
			// S24: the headline tier is the LIVE pressure band; the env preset is kept
			// alongside as presetTier so the dashboard can show both.
			tier: this.pressureBand,
			presetTier: this.config.tier,
			pressure: this.pressure,
			config: {
				fastGatePct: this.config.fastGatePct,
				thresholdTokens: this.effectiveThreshold,
				tierPct: this.config.tierPct,
				effectiveThresholdPct,
				anchorUserMessages: this.config.anchorUserMessages,
				preserveRecent: this.config.preserveRecent,
				auto: this.config.auto,
				autoInline: this.config.autoInline,
			},
			session: {
				id: this.rt.sessionId,
				state: this.statusKey ?? "idle",
				persistedThisSession: this.rt.persistedThisSession,
				lastCheckpointId: this.rt.lastCheckpointId ?? null,
				lastCompactedFrom: this.rt.lastCompactedFrom,
				lastCompactedTokens: this.rt.lastCompactedTokens,
				dedupSkips: this.rt.dedupSkips,
				dedupAttempts: this.rt.dedupAttempts,
			},
			context: {
				tokens: this.lastCtxTokens,
				percent: this.lastCtxPercent,
				contextWindow: this.lastCtxWindow,
			},
			trigger: {
				armed,
				ready,
				currentTokens: this.lastCtxTokens,
				thresholdTokens: this.effectiveThreshold,
				fastGatePct: this.config.fastGatePct,
				tierPct: this.config.tierPct,
				effectiveThresholdPct,
			},
			crew: { activeAgents: this.activeAgents, currentTurn: this.currentTurn },
			store: {
				checkpointCount: st.checkpointCount,
				totalTokenEstimate: st.totalTokenEstimate,
				originalTokens: st.originalTokens,
				tokensSaved: this.rt.tokensSaved,
				injectedCount: st.injectedCount,
				dedupHitRate: st.dedupHitRate,
				storageDedupRate: st.storageDedupRate,
				dedupAttempts: st.dedupAttempts,
				dedupCollapsed: st.dedupCollapsed,
			},
			// Reconciled token accounting (single canonical formula, session + repo).
			// Freed = In − Out; In = Freed + Out. session.Freed = rt.tokensSaved (incl.
			// deduped-away originals); repo.Freed = repo.tokensSaved meta counter.
			compression: {
				session: {
					tokensIn: this.rt.tokensSaved + st.totalTokenEstimate,
					tokensOut: st.totalTokenEstimate,
					tokensFreed: this.rt.tokensSaved,
					compressionPct:
						this.rt.tokensSaved + st.totalTokenEstimate > 0
							? this.rt.tokensSaved /
								(this.rt.tokensSaved + st.totalTokenEstimate)
							: 0,
					dedupPct: st.storageDedupRate,
				},
				repo: {
					tokensIn: repo.tokensSaved + repo.totalTokenEstimate,
					tokensOut: repo.totalTokenEstimate,
					tokensFreed: repo.tokensSaved,
					compressionPct:
						repo.tokensSaved + repo.totalTokenEstimate > 0
							? repo.tokensSaved / (repo.tokensSaved + repo.totalTokenEstimate)
							: 0,
					dedupPct: repo.storageDedupRate,
				},
			},
			repo: {
				checkpointCount: repo.checkpointCount,
				totalTokenEstimate: repo.totalTokenEstimate,
				originalTokens: repo.originalTokens,
				tokensSaved: repo.tokensSaved,
				sessionCount: repo.sessionCount,
				dedupAttempts: repo.dedupAttempts,
				dedupCollapsed: repo.dedupCollapsed,
				storageDedupRate: repo.storageDedupRate,
			},
			integrity: {
				regionsRetained: di.regionsRetained,
				compressedOriginalBytes: di.compressedOriginalBytes,
				duplicatesCollapsed: di.duplicatesCollapsed,
				bytesPermanentlyDeleted: di.bytesPermanentlyDeleted,
			},
			cacheHits: {
				session: cacheHitsSession,
				total: cacheHitsTotal,
				sessionTokensSaved: this.rt.cacheHitTokens,
				totalTokensSaved: cacheHitsTotalTokens,
			},
			compacts: {
				session: this.rt.compactCount,
				total: getCompactCount(this.currentStateDir),
			},
			timeSaved: {
				compact: { sessionSec: sec(this.rt.tokensSaved), totalSec: sec(this.store.repoStats().tokensSaved) },
				cacheHit: { sessionSec: sec(this.rt.cacheHitTokens), totalSec: sec(cacheHitsTotalTokens) },
			},
			model,
		} as DashboardSnapshot);

		// Live stats widget above the editor
		if (ctx) {
			// ── gather widget data (computed per snapshot, rendered per frame) ────
			const tokStr =
				this.lastCtxTokens != null
					? `${Math.round(this.lastCtxTokens / 1000)}k`
					: "?";
			const maxStr =
				this.lastCtxWindow > 0
					? `${Math.round(this.lastCtxWindow / 1000)}k`
					: "?";
			const pctStr =
				this.lastCtxPercent != null
					? this.lastCtxPercent > 100
						? `>100%` // S29: overshoot warning, not a raw "250%" — the percent trigger now compacts before 100%, so this is the residual case where it can't keep up.
						: `${Math.round(this.lastCtxPercent * 10) / 10}%`
					: "?%";
			// S24: the tier label is the LIVE pressure band (low/medium/high/ultra/
			// mega), not the static env preset. It climbs as context fills.
			const liveBand = this.pressureBand;
			const tierLabel = `${C.bold}${liveBand}${C.reset}${C.gray}·${this.config.tier}${C.reset}`;
			const triggerLabel = ready
				? `${C.green}● ready${C.reset}`
				: armed
					? `${C.amber}◐ armed${C.reset}`
					: `${C.gray}○ idle${C.reset}`;
			// Storage dedup rate is cumulative (store-wide, per-repo) and survives
			// session resets. Always show a number (decimal for sub-10%).
			const storageRate = st.storageDedupRate; // 0..1
			const dedupStr =
				storageRate * 100 >= 10
					? `${Math.round(storageRate * 100)}%`
					: `${(storageRate * 100).toFixed(1)}%`;
			// Agents view: count + status (S27 per-agent tokens are gated on P0).
			const agentLabel =
				this.activeAgents > 0
					? `🤖 ${this.activeAgents} agent${this.activeAgents === 1 ? "" : "s"}`
					: `${C.dim}🤖 idle${C.reset}`;
			const agentStr = ` │ ${agentLabel}`;
			const turnStr = this.currentTurn > 0 ? ` │ turn ${this.currentTurn}` : "";
			// Reconciled in/out view (session + repo) — ONE canonical formula.
			const sessIn = this.rt.tokensSaved + st.totalTokenEstimate;
			const sessKept = st.totalTokenEstimate;
			const sessPct = sessIn > 0 ? this.rt.tokensSaved / sessIn : 0;
			const repoIn = repo.tokensSaved + repo.totalTokenEstimate;
			const repoKept = repo.totalTokenEstimate;
			const repoPct = repoIn > 0 ? repo.tokensSaved / repoIn : 0;
			const sTxt = (sessPct * 100).toFixed(sessPct * 100 >= 10 ? 0 : 1);
			const rTxt = (repoPct * 100).toFixed(repoPct * 100 >= 10 ? 0 : 1);
			const ctxPct =
				this.lastCtxPercent != null ? this.lastCtxPercent / 100 : 0;
			// Model + provider (S26 capture) for the header.
			const modelName = modelSnap?.modelName ?? modelSnap?.modelId ?? "?";
			const modelStr = modelSnap?.provider
				? `${modelName}·${modelSnap.provider}`
				: modelName;
			// Since-last-compact (ms; null until first compaction this session).
			const sinceCompact =
				this.rt.lastCompactAt != null
					? Date.now() - this.rt.lastCompactAt
					: null;
			// Memory store: embedder + compression ratio (original / stored).
			const embedderName = this.embedderName();
			const compRatio =
				st.originalTokens > 0 && st.totalTokenEstimate > 0
					? st.originalTokens / st.totalTokenEstimate
					: st.originalTokens > 0
						? 1
						: 0;
			const compStr = compRatio >= 1 ? `${compRatio.toFixed(1)}x` : "—";
			// Cross-repo drift status (cached, read-only).
			const driftStatus = this.driftStatus();
			const agentsActive = this.activeAgents > 0;

			// S31: game-mode state for the widget (theme/mode/level + MEGA CACHE).
			// Pulled from the cached game_state row; cachePct is the REAL dedup hit
			// rate (may exceed 100% — that's the MEGA CACHE trigger). megaCacheFlare
			// is false for now (S33.4 scoring hook arms it when cachePct > 100).
			const gs = this.getCachedGameState();
			// S34: derive the level-up flare from the turn count each snapshot.
			const curLevel = this.getTurnLevel();
			if (curLevel > this.lastLevel) {
				this.levelUpFlare = true;
				// v0.8.3: arm a pulse border effect to celebrate the level-up.
				this.setEffect("pulse", "accent", 1500);
			}
			const cachePct = st.dedupHitRate * 100;
			this.widgetData = {
				version: ownVersion(),
				tierLabel,
				triggerLabel,
				pctStr,
				tokStr,
				maxStr,
				ctxPct,
				chk: st.checkpointCount,
				agentStr,
				turnStr,
				dedupStr,
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
				embedderName,
				compStr,
				driftStatus,
				agentsActive,
				fresh: Date.now() - this.lastActivityAt < 4000,
				ticker: this.ticker,
				lastWhy: this.lastWhy,
				tierTrace: this.tierTrace,
				pulsing: this.pulsing,
				// S31 game-mode fields:
				gameMode: gs.game_mode_on,
				theme: getTheme(gs.theme) ? gs.theme : "transparent",
				tuiMode: gs.tui_display_mode,
				level: this.getTurnLevel(),
				cachePct,
				megaCacheFlare: this.megaCacheFlare,
				megaCacheFlarePct: this.megaCacheFlarePct,
				levelUpFlare: this.levelUpFlare,
				achievementFlare: this.achievementFlare,
				achievementFlareTitles: this.achievementFlareTitles,
				// v0.8.3: ambient border effect — threaded live so the widget can
				// compute the per-frame phase and render animated borders.
				activeEffect: this.activeEffect,
			};
			// S33: consume the flare after copying it into widgetData so it fires
			// for exactly one render cycle (the gag flares once, then clears).
			this.megaCacheFlare = false;
			this.megaCacheFlarePct = 0;

			// S34: consume the level-up flare after one render cycle (mirrors the
			// megaCacheFlare one-shot semantics), and advance lastLevel.
			this.levelUpFlare = false;
			this.lastLevel = curLevel;
			// S35: consume the achievement-unlock flare after one render cycle
			// (mirrors the megaCacheFlare/levelUpFlare one-shot semantics).
			this.achievementFlare = false;
			this.achievementFlareTitles = [];
			// v0.8.3: expire the ambient border effect once its time window has
			// elapsed. SEPARATE from the one-shot flares above (those are per-cycle
			// consumes; activeEffect is time-windowed and cleared when Date.now()
			// crosses startedAt + durationMs). The widget also defends this per-frame
			// (effectBorderSgr returns '' once expired), so this is bookkeeping to
			// free the slot and prevent a stale effect lingering between snapshots.
			if (
				this.activeEffect &&
				Date.now() - this.activeEffect.startedAt >=
					this.activeEffect.durationMs
			) {
				this.activeEffect = null;
			}
			// Auto-fit: register a factory so pi re-renders the panel at the REAL
			// terminal width every frame (tui.columns), instead of guessing with
			// process.stdout.columns. buildWidgetLines reads this.widgetData live.
			this.renderWidget(ctx);
		}
		// v0.8.5: record the material-change signature computed at the top so the
		// next snapshot() can skip this whole body when nothing material changed.
		this.lastSnapshotSig = sig;
	}

	/** Register the above-editor widget as a width-aware factory so pi re-renders
	 *  it at the REAL terminal width every frame (auto-fit wide/narrow). The
	 *  factory returns a minimal Component whose render() reads this.widgetData.
	 */
	private renderWidget(ctx: ExtensionContext): void {
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

	/** v0.8.5: cheap material-change signature over live runtime fields (no
	 *  SQLite). Two snapshots with the same signature produce identical
	 *  dashboard.json + widgetData, so the 6 synchronous SQLite opens + the
	 *  writeFileSync(dashboard.json) can be skipped. Built from in-memory state
	 *  only; gameStateBump covers cross-process game_state edits (fs.watch) +
	 *  in-process /mega-game writes (bumpGameState) + repo switches (bindRepo).
	 *  The transient flare flags are included so a one-shot flare forces the
	 *  recompute that renders (then clears) it for exactly one cycle. */
	private materialSig(): string {
		const rt = this.rt;
		const ae = this.activeEffect;
		return JSON.stringify([
			this.lastCtxTokens, this.lastCtxPercent, this.lastCtxWindow,
			this.activeAgents, this.currentTurn,
			rt.compactCount, rt.tokensSaved, rt.dedupSkips, rt.dedupAttempts,
			rt.recallInjections, rt.cacheHitTokens, rt.persistedThisSession,
			rt.lastCheckpointId ?? null, rt.lastCompactedFrom, rt.lastCompactedTokens,
			this.statusKey ?? null,
			this.currentModel?.modelId ?? null, this.currentModel?.provider ?? null,
			ae ? `${ae.type}:${ae.role}:${ae.startedAt}` : null,
			this.gameStateBump,
			this.megaCacheFlare, this.megaCacheFlarePct,
			this.levelUpFlare, this.achievementFlare,
			this.achievementFlareTitles.join("|"),
			this.tierTrace ?? null, this.lastWhy ?? null, this.pulsing,
			this.ticker.length,
		]);
	}

	/** Active embedder name for the memory-store line (Trigram default / MiniLM). */
	private embedderName(): string {
		// MINILM_EMBEDDER flag lives in src/config/dedup.ts; read the same env var
		// the embedder factory uses so the label matches what's actually running.
		return process.env.MEGACOMPACT_MINILM === "true" ||
			process.env.MEGACOMPACT_MINILM === "1"
			? "MiniLM"
			: "Trigram";
	}

	/** Cross-repo drift status (ok | warn), cached for 30s (opens the registry DB). */
	private driftStatus(): "ok" | "warn" {
		const now = Date.now();
		if (this.driftCache && now - this.driftCache.at < 30_000)
			return this.driftCache.status;
		let status: "ok" | "warn" = "ok";
		try {
			const report = detectCrossRepoDrift();
			status = report.totals.warn > 0 ? "warn" : "ok";
		} catch {
			status = "ok";
		}
		this.driftCache = { at: now, status };
		return status;
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
	};
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

	/**
	 * Capture the active model/provider from ctx.model and persist it so cost
	 * estimation + the dashboard can read real pricing. Cheap + idempotent-ish:
	 * only writes a new row when the model id changes (models change rarely).
	 */
	captureModel(ctx: ExtensionContext): void {
		const m = ctx.model;
		if (!m) {
			this.appendEvent("captureModel:no-model", { cwd: ctx.cwd });
			return;
		}
		if (
			this.currentModel &&
			this.currentModel.modelId === m.id &&
			this.currentModel.provider === m.provider
		)
			return;
		let providerName: string | null = null;
		try {
			providerName =
				ctx.modelRegistry?.getProviderDisplayName(m.provider) ?? null;
		} catch {
			/* optional */
		}
		const snap: Omit<ModelSnapshot, "capturedAt"> = {
			provider: m.provider,
			providerName,
			modelId: m.id,
			modelName: m.name ?? null,
			inputRate: m.cost?.input ?? 0,
			outputRate: m.cost?.output ?? 0,
			contextWindow: m.contextWindow ?? 0,
			maxTokens: m.maxTokens ?? 0,
			reasoning: !!m.reasoning,
		};
		this.currentModel = { ...snap, capturedAt: Date.now() };
		this.diagCaptureModelCalls++;
		const repo = resolveRepoRoot(ctx.cwd) ?? this.currentStateDir;
		// S26: previously a single silent `catch {}` hid every capture failure, so
		// model_snapshots stayed empty and the cost card read $0.00 with zero signal.
		// Split per-write + append to events.log (always-on, dashboard live-streams
		// it) + bump a DIAG counter so a live capture surfaces the root cause.
		try {
			recordModelSnapshot(repo, snap, this.currentStateDir);
			this.appendEvent("captureModel:recorded", {
				repo,
				modelId: snap.modelId,
				provider: snap.provider,
				inputRate: snap.inputRate,
				outputRate: snap.outputRate,
			});
		} catch (e) {
			this.diagCaptureModelFails++;
			this.appendEvent("captureModel:record-failed", {
				repo,
				modelId: snap.modelId,
				error: e instanceof Error ? e.message : String(e),
				stack: e instanceof Error ? e.stack : undefined,
			});
		}
		try {
			// Denormalize the active model into the machine-wide index so the
			// All-repos dashboard table can show provider/model per repo without
			// opening every repo's DB. Best-effort + non-fatal.
			recordRepoModel(repo, {
				provider: snap.provider,
				providerName: snap.providerName,
				modelName: snap.modelName,
				inputRate: snap.inputRate,
				outputRate: snap.outputRate,
				stateDir: this.currentStateDir,
				displayName: repo.split(/[\\/]/).filter(Boolean).pop() ?? repo,
			});
		} catch (e) {
			this.appendEvent("captureModel:index-record-failed", {
				repo,
				modelId: snap.modelId,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	/**
	 * Append a structured line to the repo's events.log — the always-on
	 * diagnostics sink the dashboard live-streams. Unlike this.logger (gated by
	 * config.debug), this fires in production, so capture failures surface during
	 * a real capture even with debugging off. Best-effort + non-fatal.
	 */
	private appendEvent(event: string, fields: Record<string, unknown>): void {
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
	private ensureGameStateWatcher(): void {
		if (this.gameStateWatcher && this.gameStateWatchDir === this.currentStateDir) {
			return;
		}
		if (this.gameStateWatcher) {
			try { this.gameStateWatcher.close(); } catch { /* non-fatal */ }
			this.gameStateWatcher = undefined;
			this.gameStateWatchDir = undefined;
		}
		try {
			// Watch the state DIR (not just sqlite.db) and filter by filename.
			// Why: the store is WAL-mode (openStore sets PRAGMA journal_mode=WAL).
			// Cross-process writes (dashboard server child) append to sqlite.db-wal
			// and do NOT modify sqlite.db until a checkpoint — and a long-lived
			// parent connection (VectorStore + dashboard readers) keeps the WAL
			// uncheckpointed, so a watcher on sqlite.db alone never fires and
			// cachedGameState stays stale (theme stuck after a dashboard edit).
			// Watching the dir + matching sqlite.db* catches the main db, the -wal
			// sidecar, and -shm, so the memo evicts on any cross-process write. The
			// filter also excludes events.log / *.log noise in the same dir.
			this.gameStateWatcher = watch(
				this.currentStateDir,
				(_eventType, filename) => {
					if (typeof filename === "string" && filename.startsWith("sqlite.db")) {
						this.cachedGameState = undefined;
						this.gameStateBump++;
					}
				},
			);
			this.gameStateWatchDir = this.currentStateDir;
		} catch {
			/* non-fatal: missing dir / platform issue — next snapshot re-queries */
		}
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
	}

	/** S31: the cached game-mode state (game_mode_on/theme/tui_display_mode).
	 *  Lazily read from the game_state SQLite row on the first call, then
	 *  memoized until `bumpGameState()` evicts it. Reading is non-throwing
	 *  (getGameState returns DEFAULT_GAME_STATE on any error), so the widget
	 *  can call this on every render safely. */
	getCachedGameState(): GameState {
		if (!this.cachedGameState) {
			try {
				this.cachedGameState = getGameState(this.currentStateDir);
			} catch {
				this.cachedGameState = {
					game_mode_on: false,
					theme: "transparent",
					tui_display_mode: "full",
				};
			}
		}
		return this.cachedGameState;
	}

	/** S31: evict the cached game-mode state so the next widget render re-reads
	 *  the game_state row. Called by /mega-game after every setGameState() so
	 *  the panel picks up theme/mode/toggle changes live. */
	bumpGameState(): void {
		this.cachedGameState = undefined;
		this.gameStateBump++;
	}

	/** S33: player level for game mode — floor(log2(turns+1))+1 (gentle).
	 *  Defensive: non-finite/negative collapses to 1 (never NaN). */
	private getTurnLevel(): number {
		return turnLevel(this.currentTurn);
	}

	/** S33: arm the transient MEGA CACHE flare so the next snapshot() copies it
	 *  into widgetData and the widget renders the oopsie gag for one cycle.
	 *  v0.8.3: also arm a 'flash' ambient effect on the panel borders (mega
	 *  color) for 1.2s. */
	armMegaCacheFlare(peakPct: number): void {
		this.megaCacheFlare = true;
		this.megaCacheFlarePct = peakPct;
		this.setEffect("flash", "mega", 1200);
	}

	/** S35: arm the transient achievement-unlock flare with the newly-unlocked
	 *  titles so the next snapshot() copies them into widgetData and the widget
	 *  renders the one-time unlock toast for one render cycle.
	 *  v0.8.3: also arm a 'pulse' ambient effect on the panel borders (accent
	 *  color) for 2s to celebrate the unlock. */
	armAchievementFlare(titles: string[]): void {
		this.achievementFlare = true;
		this.achievementFlareTitles = titles;
		this.setEffect("pulse", "accent", 2000);
	}

	/** v0.8.3: arm an ambient border effect (animated pulse/flash on the panel
	 *  borders). Replaces any in-flight effect (last call wins — a later event
	 *  like a level-up during an achievement pulse simply overrides). The widget
	 *  reads activeEffect each frame and computes the per-frame phase from
	 *  startedAt vs Date.now(); it renders '' once the window elapses. */
	setEffect(
		type: "pulse" | "flash",
		role: "accent" | "mega" | "red",
		durationMs: number,
	): void {
		this.activeEffect = { type, role, startedAt: Date.now(), durationMs };
	}

	/** Build the sync onTier callback that paints the live per-tier trace. */
	makeTierCallback(
		ctx: ExtensionContext,
	): (ev: {
		tier: "L0" | "L1" | "L2" | "new";
		status: "scanning" | "deduped" | "passed" | "stored";
		detail?: string;
	}) => void {
		const order: Array<"L0" | "L1" | "L2" | "new"> = ["L0", "L1", "L2", "new"];
		const seen = new Map<string, string>();
		const glyph = (status: string) =>
			status === "deduped"
				? `${C.green}✓${C.reset}`
				: status === "passed"
					? `${C.dim}○${C.reset}`
					: status === "scanning"
						? `${C.amber}…${C.reset}`
						: `${C.cyan}●${C.reset}`;
		return (ev) => {
			const label =
				ev.tier === "new"
					? `${C.cyan}stored${C.reset}`
					: `${ev.tier} ${glyph(ev.status)}` +
						(ev.detail ? ` ${C.gray}(${ev.detail})${C.reset}` : "");
			// Show the most recent outcome per tier (collapses re-fires).
			seen.set(ev.tier, label);
			const show: string[] = [];
			for (const t of order) if (seen.has(t)) show.push(seen.get(t)!);
			this.tierTrace = `${C.teal}⚙${C.reset} ${show.join(` ${C.gray}→${C.reset} `)}`;
			this.lastActivityAt = Date.now();
			try {
				this.snapshot(ctx);
			} catch {
				/* non-fatal */
			}
		};
	}

	// Phase 3 — recall/activity ticker ring buffer.
	pushTicker(text: string): void {
		this.ticker.push({ text, at: Date.now() });
		while (this.ticker.length > this.TICKER_MAX) this.ticker.shift();
		this.lastActivityAt = Date.now();
	}

	/** Convert the messages pi hands us in the `context` event into the engine view. */
	engineView(messages: AgentMessage[]): ReturnType<typeof toEngineMessages> {
		return toEngineMessages(messages);
	}
}
