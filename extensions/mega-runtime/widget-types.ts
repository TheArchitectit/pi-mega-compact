/**
 * widget-types.ts — the `TickerEntry` and `WidgetData` interfaces extracted from
 * the original widget.ts so the ANSI helpers (widget-ansi.ts) and the render
 * function (widget.ts) can import them without a cycle.
 *
 * Pure type definitions — zero runtime code, zero imports.
 */

/** Ticker ring-buffer entry (recall/activity history for the widget footer). */
export interface TickerEntry {
	text: string;
	at: number;
}

/** Immutable snapshot of everything the above-editor widget needs to render.
 *  Computed once per `snapshot()` (event-driven) and read by `buildWidgetLines`
 *  on every TUI render frame, so frame rendering stays allocation-cheap and the
 *  panel auto-fits whatever width pi passes to the setWidget factory. */
export interface WidgetData {
	version: string;
	tierLabel: string;
	triggerLabel: string;
	pctStr: string;
	tokStr: string;
	maxStr: string;
	ctxPct: number;
	chk: number;
	agentStr: string;
	turnStr: string;
	dedupStr: string;
	sessIn: number;
	sessKept: number;
	sTxt: string;
	repoIn: number;
	repoKept: number;
	rTxt: string;
	repoChk: number;
	repoSess: number;
	modelStr: string;
	sinceCompact: number | null;
	embedderName: string;
	compStr: string;
	driftStatus: "ok" | "warn";
	agentsActive: boolean;
	fresh: boolean;
	ticker: TickerEntry[];
	lastWhy: string | undefined;
	tierTrace: string | undefined;
	pulsing: boolean;
	// ── S31: game-mode theming + display modes + level + MEGA CACHE flare ──
	/** Game mode on (shows level + MEGA CACHE flare; hides them when off). */
	gameMode?: boolean;
	/** Theme id (src/config/themes). Drives the panel bg + accent/mega ANSI. */
	theme?: string;
	/** TUI display mode: 'full' (default) = the full stats panel; 'minimal' = a
	 *  one-line `LVL n | cache NN%` view flanked by panel bars. */
	tuiMode?: "full" | "minimal";
	/** Player level (game-mode). Stub = 1 until S33 wires the real scoring. */
	level?: number;
	/** Cache hit rate as a percent (0..100+, may exceed 100 → MEGA CACHE). */
	cachePct?: number;
	/** MEGA CACHE flare armed (fires at cachePct >= 100 + gameMode on). Adds the
	 *  ANSI MEGA CACHE banner + the oopsie gag to the header. */
	megaCacheFlare?: boolean;
	/** The peak cache % that armed the flare (for the oopsie toast text). */
	megaCacheFlarePct?: number;
	levelUpFlare?: boolean;
	/** S35: achievement-unlock flare -- renders a one-line toast for one cycle. */
	achievementFlare?: boolean;
	achievementFlareTitles?: string[];
	/** v0.8.3: ambient animated border effect (null when idle/expired). The
	 *  widget computes the per-frame phase from startedAt vs Date.now() and
	 *  renders a pulse/flash on the panel borders; '' once the window elapses. */
	activeEffect?: {
		type: "pulse" | "flash";
		role: "accent" | "mega" | "red";
		startedAt: number;
		durationMs: number;
	} | null;
	/** A3: per-turn cache hit percentage (most recent turn's hit/miss ratio,
	 *  0–100). Separate from cachePct (running average) for trend visibility. */
	perTurnCacheHitPct?: number;
}
