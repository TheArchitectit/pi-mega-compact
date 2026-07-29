/**
 * game-state.ts — extracted game-state management for MegaRuntime.
 *
 * This module keeps the game-state logic cohesive while leaving the class fields
 * and public method signatures in state.ts. The original methods become thin
 * delegates so runtime behavior stays byte-for-byte identical.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { watch } from "node:fs";
import { getGameState, type GameState } from "../../src/store/sqlite.js";
import { getTheme } from "../../src/config/themes.js";
import { disposePerf, type PerfContext } from "./perf.js";

export interface GameWatcherLike {
	close(): void;
	/** fs.FSWatcher has it; test doubles need not. */
	unref?(): unknown;
}

export interface GameStateContext {
	readonly currentStateDir: string;
	cachedGameState: GameState | undefined;
	gameStateBump: number;
	gameStateWatcher?: GameWatcherLike;
	gameStateWatchDir?: string;
	lastWidgetCtx?: ExtensionContext;
	widgetData: import("./widget.js").WidgetData | null;
}

export interface GameStateViewApi {
	renderWidget(ctx: ExtensionContext): void;
}

export function getCachedGameStateImpl(self: GameStateContext): GameState {
	if (!self.cachedGameState) {
		try {
			self.cachedGameState = getGameState(self.currentStateDir);
		} catch {
			self.cachedGameState = {
				game_mode_on: false,
				theme: "transparent",
				tui_display_mode: "full",
			};
		}
	}
	return self.cachedGameState;
}

export function refreshWidgetGameStateImpl(
	self: GameStateContext,
	view: GameStateViewApi,
	ctx: ExtensionContext,
): void {
	if (!self.widgetData || !ctx) return;
	const gs = getCachedGameStateImpl(self);
	self.widgetData.gameMode = gs.game_mode_on;
	self.widgetData.theme = getTheme(gs.theme) ? gs.theme : "transparent";
	self.widgetData.tuiMode = gs.tui_display_mode;
	view.renderWidget(ctx);
}

export function bumpGameStateImpl(self: GameStateContext): void {
	self.cachedGameState = undefined;
	self.gameStateBump++;
}

// ------------------------------------------------------------- disposeRuntime

/**
 * The slice of `MegaRuntime` dispose() touches: the S32 fs.watch game-state
 * watcher (GameStateContext) plus the v0.8.8 perf cpu/mem sampling interval
 * (PerfContext). `MegaRuntime` satisfies this structurally.
 */
export interface DisposeRuntimeContext extends GameStateContext, PerfContext {}

/** S32: release the fs.watch game-state watcher AND stop the v0.8.8 perf
 *  sampling interval. Called when the runtime is torn down (no existing
 *  dispose path — the process exit reclaims the fd, but explicit close is
 *  correct for any in-process reload / test reuse). Extracted from
 *  MegaRuntime.dispose(); the class keeps a thin delegate. */
export function disposeRuntimeImpl(self: DisposeRuntimeContext): void {
	if (self.gameStateWatcher) {
		try { self.gameStateWatcher.close(); } catch { /* non-fatal */ }
		self.gameStateWatcher = undefined;
		self.gameStateWatchDir = undefined;
	}
	disposePerf(self);
}

export function ensureGameStateWatcherImpl(self: GameStateContext, view: GameStateViewApi): void {
	if (self.gameStateWatcher && self.gameStateWatchDir === self.currentStateDir) {
		return;
	}
	if (self.gameStateWatcher) {
		try {
			self.gameStateWatcher.close();
		} catch {
			/* non-fatal */
		}
		self.gameStateWatcher = undefined;
		self.gameStateWatchDir = undefined;
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
		self.gameStateWatcher = watch(
			self.currentStateDir,
			(_eventType, filename) => {
				if (typeof filename === "string" && filename.startsWith("sqlite.db")) {
					self.cachedGameState = undefined;
					self.gameStateBump++;
					// P2: force a widget re-render so a dashboard-made theme/toggle/
					// tui-mode change reflects in the live TUI immediately, even when
					// pi is idle (no context event to drive snapshot()). Use the
					// LIGHTWEIGHT refreshWidgetGameState() — NOT the full snapshot():
					// snapshot() recomputes 6 sync SQLite opens + writes dashboard.json
					// + writes to the store, and those store writes RETRIGGER this
					// same fs.watch callback (it fires on every sqlite.db* write) →
					// re-entrant thrash → 190s test timeout under mega-compact.test.js
					// / mega-teamrun.test.js. The lightweight path re-reads ONLY the
					// game_state row and patches the three game-mode fields on the
					// existing widgetData, then re-registers the factory via
					// renderWidget() — it writes nothing to the store or
					// dashboard.json, so it cannot retrigger itself. Guard: skip until
					// the first snapshot stashed a ctx (no widget registered yet →
					// nothing to refresh). Non-fatal: next context event re-snapshots.
					const ctx = self.lastWidgetCtx;
					if (ctx) {
						try {
							refreshWidgetGameStateImpl(self, view, ctx);
						} catch {
							/* non-fatal */
						}
					}
				}
			},
		);
		// The watcher is a cache-eviction convenience, never a reason to stay
		// alive: an active+referenced fs_event handle holds node's event loop
		// open, so a runtime that was never dispose()d (every extension test, and
		// any `pi -p` run that skips session_shutdown) hangs the process after all
		// work is done. unref'd like the perf interval — while pi runs there are
		// always other referenced handles, so the watcher still fires normally.
		self.gameStateWatcher.unref?.();
		self.gameStateWatchDir = self.currentStateDir;
	} catch {
		/* non-fatal: missing dir / platform issue — next snapshot re-queries */
	}
}
