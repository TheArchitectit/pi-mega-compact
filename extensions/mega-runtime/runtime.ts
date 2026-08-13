/**
 * runtime.ts — the `MegaRuntime` class: shared live state of the mega-compact
 * extension.
 *
 * Phase 2d (maximal split): the class body is field declarations, the
 * constructor, and 1-line delegates only. Every method body lives in its own
 * module following the context-interface + free-function + thin-delegate
 * pattern: pressure-getters.ts / append-event.ts /
 * get-state-dir.ts / render-widget.ts / status.ts / engine-view.ts /
 * runtime-snapshot.ts / runtime-helpers.ts / effects.ts / game-state.ts /
 * capture-model.ts / bind-repo.ts / perf.ts. state.ts re-exports the class for
 * backwards compatibility.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import { VectorStore } from "../../src/vectorStore.js";
import type { toEngineMessages } from "../../src/adapt.js";
import { Logger } from "../../src/log.js";

export { RING_MAX } from "./internal-errors.js";
import type {
	GameState,
} from "../../src/store/sqlite.js";
import type {
	MegaConfig,
	PressureBand,
} from "../mega-config.js";
import { Dashboard } from "../mega-dashboard.js";
import type {
	SessionRuntime,
} from "./helpers.js";
import { createSessionRuntime } from "./helpers.js";
import {
	ensureGameStateWatcherImpl,
	getCachedGameStateImpl,
	refreshWidgetGameStateImpl,
	bumpGameStateImpl,
	disposeRuntimeImpl,
} from "./game-state.js";
import {
	setEffectImpl,
	armMegaCacheFlareImpl,
	armAchievementFlareImpl,
	makeTierCallbackImpl,
	pushTickerImpl,
} from "./effects.js";
import { ensurePerfIntervalImpl } from "./perf.js";
import { captureModelImpl } from "./capture-model.js";
import { bindRepoImpl } from "./bind-repo.js";
import { snapshotImpl } from "./runtime-snapshot.js";
import {
	pressureImpl,
	effectiveThresholdImpl,
	pressureBandImpl,
} from "./pressure-getters.js";
import { resetRuntimeImpl } from "./reset-runtime.js";
import { appendEventImpl } from "./append-event.js";
import { recordInternalErrorImpl } from "./internal-errors.js";
import { RuntimeInstrumentation } from "./runtime-instrumentation.js";
import { getStateDirImpl } from "./get-state-dir.js";
import { renderWidgetImpl } from "./render-widget.js";
import { setStatusImpl } from "./status.js";
import { engineViewImpl } from "./engine-view.js";

export class MegaRuntime extends RuntimeInstrumentation {
	config: MegaConfig;
	// Store/dashboard/logger are rebound per-repo by bindRepo() so each git repo
	// gets its own isolated state dir. They start bound to the global default.
	store: VectorStore;
	logger: Logger;
	dashboard: Dashboard;
	activeRepoRoot: string | null = null;
	currentStateDir: string;

	// The only mutable per-session state. Reset on session_start / session_tree.
	// Initialized via createSessionRuntime() (helpers.ts delegate-shell split).
	rt: SessionRuntime = createSessionRuntime();

	// All other field declarations (instrumentation counters, context-health
	// rings, the Sprint-H internal-error ring, live display / cache-stability
	// state) live on the RuntimeInstrumentation base class — see
	// runtime-instrumentation.ts. Field names are unchanged (this.diagXxx,
	// this.trimCache, this.recentInternalErrors, etc).

	// ---- pressure accessors (bodies in pressure-getters.ts) -------------------

	/** Live 0–1 pressure — see `pressureImpl` in pressure-getters.ts for the
	 *  dual-basis (percent vs token) reconciliation notes. Thin delegate. */
	get pressure(): number {
		return pressureImpl(this);
	}

	/** The live compaction fire point in tokens — thin delegate to
	 *  `effectiveThresholdImpl` (pressure-getters.ts). */
	get effectiveThreshold(): number {
		return effectiveThresholdImpl(this);
	}

	/** Live discrete pressure band (low/medium/high/ultra/mega) — thin delegate
	 *  to `pressureBandImpl` (pressure-getters.ts). */
	get pressureBand(): PressureBand {
		return pressureBandImpl(this);
	}

	constructor(config: MegaConfig) {
		super();
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

	/** Width-aware above-editor widget factory registration — thin delegate to
	 *  `renderWidgetImpl` (render-widget.ts).
	 *
	 *  Gated on `config.tuiWidget` (MEGACOMPACT_TUI_WIDGET=0 to disable). This
	 *  is the single chokepoint every caller funnels through, so returning here
	 *  means setWidget is never called and the panel is never registered — as
	 *  opposed to registering an empty one, which would still occupy a row. */
	renderWidget(ctx: ExtensionContext): void {
		if (!this.config.tuiWidget) return;
		renderWidgetImpl(this, ctx);
	}

	/** Mirror the dashboard status text onto pi's status line — thin delegate to
	 *  `setStatusImpl` (status.ts). */
	setStatus(ctx: ExtensionContext, text: string | undefined): void {
		setStatusImpl(this, ctx, text);
	}

	/** Per-session state reset (session_start / session_tree) — thin delegate to
	 *  `resetRuntimeImpl` (reset-runtime.ts). */
	resetRuntime(sessionId: string | undefined): void {
		resetRuntimeImpl(this, sessionId);
	}

	captureModel(ctx: ExtensionContext): void {
		captureModelImpl(this, ctx);
	}

	/** Structured events.log diagnostics sink (always-on) — thin delegate to
	 *  `appendEventImpl` (append-event.ts). */
	appendEvent(event: string, fields: Record<string, unknown>): void {
		appendEventImpl(this, event, fields);
	}

	/**
	 * Sprint H (Finding 3 / Option A): record an internal store/service-write
	 * failure category into the `recentInternalErrors` ring. Called AT each
	 * failure emit site (see the §2.3a audit in
	 * docs/specs/c2-resume-and-health-fixes.md) — never by a central log filter.
	 * Mirrors `recentErrorCategories` (cap = RING_MAX, shift when over).
	 *
	 * NOTE (process boundary): the ring is per-runtime / in-memory. A child
	 * subprocess's failures do NOT reach the parent's ring; the parent-side
	 * dashboard already aggregates events.log cross-process, so nothing is lost.
	 */
	recordInternalError(category: string): void {
		recordInternalErrorImpl(this, category);
	}

	/** S21: state dir of the currently bound repo (where memories live) — thin
	 *  delegate to `getStateDirImpl` (get-state-dir.ts). */
	getStateDir(): string {
		return getStateDirImpl(this);
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

	/** S32: release the fs.watch game-state watcher + stop the v0.8.8 perf
	 *  sampling interval. Called when the runtime is torn down (no existing
	 *  dispose path — the process exit reclaims the fd, but explicit close is
	 *  correct for any in-process reload / test reuse). Thin delegate to
	 *  `disposeRuntimeImpl` (game-state.ts). */
	dispose(): void {
		disposeRuntimeImpl(this);
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

	/** Convert the messages pi hands us in the `context` event into the engine
	 *  view — thin delegate to `engineViewImpl` (engine-view.ts). */
	engineView(messages: AgentMessage[]): ReturnType<typeof toEngineMessages> {
		return engineViewImpl(messages);
	}
}
