/**
 * widget.ts — above-editor widget rendering helpers (free functions, consts,
 * and interfaces) extracted from the original mega-runtime.ts monolith.
 *
 * These are pure rendering primitives with zero runtime-state dependencies;
 * the `MegaRuntime` class (state.ts) imports them to paint the panel.
 */

// pi-tui's OWN width measurers — the same functions pi-tui uses to enforce its
// render-width check ("visibleWidth(line) > width" → crash). Measuring with
// these guarantees we never disagree on a grapheme's width (e.g. RGI emoji
// like ⚡ which pi-tui counts as 2 but a naive regex counts as 1), and
// truncateToWidth both pads AND hard-clips to exactly `width` cells, so no
// off-by-one can trip the strict `> width` guard. (Fix for the
// `Rendered line N exceeds terminal width (W > W-1)` crash.)
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getTheme, DEFAULT_THEME } from "../../src/config/themes.js";

// ── ANSI palette ───────────────────────────────────────────────────────────
// The pi TUI's Text component preserves ANSI escape codes (see wrapTextWithAnsi),
// so raw escapes render as colors. No chalk dependency needed — these are just
// strings. Exported because mega-pipeline.ts and mega-commands.ts import `C`
// from the mega-runtime barrel.
export const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	amber: "\x1b[38;5;214m", // tier / ready
	green: "\x1b[38;5;120m", // saved
	cyan: "\x1b[38;5;51m", // used / live activity
	teal: "\x1b[38;5;37m", // processing (compress/dedup)
	magenta: "\x1b[38;5;201m", // dedup rate
	blue: "\x1b[38;5;75m", // repo totals
	gray: "\x1b[38;5;245m", // labels
	red: "\x1b[38;5;203m", // pressure / overflow
};

const PULSE = ["◐", "◓", "◑", "◒"];

// ── Full-width widget panel helpers ────────────────────────────────────────
// pi's above-editor widget renderer (a Container of Text lines) does NOT pass
// a terminal width to setWidget(), so lines render left-aligned by default. To
// make the widget read as a full-width status panel we pad each line to the
// real terminal width with a background fill. NOTE: C.reset is a FULL SGR
// reset, so we re-apply the panel bg after every reset to keep the background
// continuous under colored text (and under pi's own trailing reset).
/** Default panel background (dark slate). Used when no theme is threaded or
 *  the theme is transparent (no bg fill). Parametrized per-render via the
 *  `panelTheme` arg so game-mode themes can restyle the panel background.
 *  A transparent theme yields `""` so panelLine/panelBar still call
 *  truncateToWidth (the width guard holds — empty prefix adds zero cells). */
const DEFAULT_PANEL_BG = "\x1b[48;5;236m"; // dark slate panel background

/** Resolve the panel-background SGR prefix for a theme id. Transparent themes
 *  (bg=null) and unknown themes yield `""` (no bg fill) — the width guard in
 *  panelLine/panelBar still applies via truncateToWidth. */
function panelBgFor(theme: string | undefined): string {
	if (!theme || theme === DEFAULT_THEME) return "";
	const t = getTheme(theme);
	const bg = t?.ansi.bg;
	return bg ? `\x1b[${bg}m` : "";
}

/** Resolve a theme ANSI accent/mega/fg SGR prefix (`\x1b[<params>m`) for the
 *  given role. Falls back to `""` (no SGR) for transparent/unknown themes so
 *  game-mode text still renders in the default fg without color noise. */
function themeAnsi(theme: string | undefined, role: "fg" | "accent" | "mega"): string {
	const t = theme ? getTheme(theme) : undefined;
	const params = t?.ansi[role];
	return params ? `\x1b[${params}m` : "";
}

/** Emit a full SGR reset, OR `""` if `sgr` is empty (transparent theme). Keeps
 *  the panel bg continuous by NOT clobbering it with a bare reset when the
 *  accent/mega prefix was a no-op. */
function sgrReset(sgr: string): string {
	return sgr ? "\x1b[0m" : "";
}

// (Visible-width measurement is delegated to pi-tui's `visibleWidth` — imported
// above — so our width math can never diverge from pi-tui's render-width check.)

/** Wrap a string (with ANSI codes) to fit within `maxWidth` visible chars.
 *  Splits at │ separators or whitespace when possible. */
function wrapLine(text: string, maxWidth: number, panelBg: string): string[] {
	if (maxWidth <= 0) return [text];
	const panelRst = "\x1b[0m" + panelBg;
	const result: string[] = [];
	let current = "";
	let currentW = 0;
	// Split at │ boundaries first
	const segments = text.split("│");
	for (let i = 0; i < segments.length; i++) {
		const seg = (i > 0 ? "│" : "") + segments[i];
		const segW = visibleWidth(panelBg + seg.replace(/\x1b\[0m/g, panelRst));
		if (currentW + segW <= maxWidth || currentW === 0) {
			current += seg;
			currentW += segW;
		} else {
			result.push(current);
			current = seg;
			currentW = segW;
		}
	}
	if (current) result.push(current);
	return result;
}

function panelLine(content: string, width: number, panelBg: string = DEFAULT_PANEL_BG): string {
	if (width <= 0) return "";
	const panelRst = "\x1b[0m" + panelBg;
	// Apply the panel background; swap every inner full-reset for a reset that
	// re-applies the bg so the fill stays continuous under colored text.
	const withBg = panelBg + content.replace(/\x1b\[0m/g, panelRst);
	// truncateToWidth(line, width, "", true) returns EXACTLY `width` visible cells
	// (by pi-tui's measure), ANSI-preserved, space-padded. It hard-clips overflow
	// — so even a segment wider than `width` (or a width-rule mismatch) can never
	// produce a line that trips pi-tui's strict `visibleWidth(line) > width` check.
	return truncateToWidth(withBg, width, "", true) + "\x1b[0m";
}

/** A full-width hairline bar (top/bottom border of the panel). */
function panelBar(width: number, ch = "─", panelBg: string = DEFAULT_PANEL_BG): string {
	// `─` (U+2500) is narrow (1 cell) in both our measure and pi-tui's, so a
	// `ch.repeat(width)` bar is exactly `width` cells and already passes the
	// `> width` guard. truncateToWidth is belt-and-suspenders in case `ch` is
	// ever swapped for a wide/fullwidth character.
	return truncateToWidth(panelBg + ch.repeat(Math.max(0, width)), width, "", false) + "\x1b[0m";
}

// ── v0.8.3: ambient border-effect helpers ───────────────────────────────
// The panel borders animate when an `activeEffect` is armed (level-up,
// mega-cache overshoot, achievement unlock, compaction start). Two modes:
//   • pulse — a sine ramp on a 256-color base (accent=51 / mega=214 / red=203):
//     the base index is scaled by sin(π·t) so the border swells 0→peak→0 over
//     the duration, then returns to '' (idle). 256-color indices are clamped
//     to 0–255 defensively (the bases are all ≤214 so the clamp rarely bites).
//   • flash — a 120ms hard on/off alternate using the base index at full.
// Returns '' when idle, expired, or elapsed<0 (clock skew) so non-effect
// renders are byte-identical to the pre-effect panel (S31 matrix stays green).
const EFFECT_BASE: Record<"accent" | "mega" | "red", number> = {
	accent: 51,
	mega: 214,
	red: 203,
};

/** Resolve the per-frame border-fg SGR for an active effect. '' when idle or
 *  expired (the widget's real per-frame expiry enforcer — snapshot-level clear
 *  is just bookkeeping since snapshot is event-driven). */
function effectBorderSgr(
	ae: NonNullable<WidgetData["activeEffect"]> | null,
	now: number,
): string {
	if (!ae) return "";
	const elapsed = now - ae.startedAt;
	if (elapsed < 0 || elapsed >= ae.durationMs) return "";
	const base = EFFECT_BASE[ae.role];
	if (ae.type === "flash") {
		// 120ms hard alternate: on (full base) / off (no SGR).
		return Math.floor(elapsed / 120) % 2 === 0 ? `\x1b[38;5;${base}m` : "";
	}
	// pulse: sine ramp 0 → peak → 0 over the duration.
	const t = elapsed / ae.durationMs;
	const amp = Math.sin(Math.PI * t); // 0 at start/end, 1 at midpoint
	const idx = Math.max(0, Math.min(255, Math.round(base * amp)));
	return `\x1b[38;5;${idx}m`;
}

/** Prepend the effect border SGR to a panel bar line. The SGR is a pure-fg
 *  escape (zero visible width), so it never perturbs truncateToWidth's width
 *  math — the bar's own `\x1b[0m` tail resets both fg + bg. No-op when sgr=''. */
function effectBar(bar: string, sgr: string): string {
	return sgr ? sgr + bar : bar;
}

/** Token-count formatter: M at/above 1e6, k at/above 1e3, raw below.
 *  5,472,700 → "5.5mil", 24,100 → "24.1k", 142 → "142". */
function fmtTokens(x: number): string {
	return x >= 1_000_000
		? `${(x / 1_000_000).toFixed(1)}mil`
		: x >= 1000
			? `${(x / 1000).toFixed(1)}k`
			: `${Math.round(x)}`;
}

/** Retro gradient bar — `w` cells shaded by fill position (green→amber→red).
 *  Used for CONTEXT fill where low=green (room) and high=red (near the limit). */
function ramp(pct: number, w = 12): string {
	const cells = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
	const scaled = Math.max(0, Math.min(w, pct * w));
	const full = Math.floor(scaled);
	const frac = scaled - full;
	const fracCell = frac > 0 ? cells[Math.round(frac * (cells.length - 1))] : "";
	let out = "";
	for (let i = 0; i < full; i++)
		out += (i / w < 0.6 ? C.green : i / w < 0.85 ? C.amber : C.red) + "█";
	if (fracCell)
		out +=
			(full / w < 0.6 ? C.green : full / w < 0.85 ? C.amber : C.red) + fracCell;
	out +=
		C.dim + "░".repeat(Math.max(0, w - full - (fracCell ? 1 : 0))) + C.reset;
	return out;
}

/** Human "time since" string from a millisecond delta (or null → "never"). */
function sinceCompactStr(ms: number | null): string {
	if (ms == null) return "never";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

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
}

// ── buildWidgetLines ───────────────────────────────────────────────────────
// Kept as a free function (not a MegaRuntime method) so state.ts stays
// focused on state management. It reads the WidgetData snapshot + the live
// activeAgents counter (passed in) and returns the panel lines.

/** Build the full-width panel lines from the latest snapshot. Cheap: reads
 *  only the WidgetData + a couple of live counters; no DB/IO. */
export function buildWidgetLines(
	wd: WidgetData | null,
	width: number,
	activeAgents: number,
): string[] {
	// Resolve the panel background from the threaded theme (transparent → "",
	// unknown → default dark slate). Computed once per render; threaded into
	// every panelLine/panelBar/wrapLine so the bg stays continuous and the width
	// guard (truncateToWidth) still holds for transparent themes.
	const panelBg = wd?.theme ? panelBgFor(wd.theme) : DEFAULT_PANEL_BG;
	// v0.8.3: resolve the animated border SGR once per render. '' when idle,
	// expired, or wd is null (warm-up) — so non-effect renders are byte-identical
	// to the pre-effect panel (the existing S31 matrix tests stay green).
	const now = Date.now();
	const borderSgr = effectBorderSgr(wd?.activeEffect ?? null, now);
	if (!wd) {
		return [
			effectBar(panelBar(width, "─", panelBg), borderSgr),
			panelLine(" mega-compact: warming up…", width, panelBg),
			effectBar(panelBar(width, "─", panelBg), borderSgr),
		];
	}
	// S31: minimal TUI mode — a single content line `LVL n | cache NN%` flanked
	// by panel bars. Built through the same panelLine/panelBar helpers so the
	// width guard + theme bg apply identically to the full panel. Level is shown
	// only when game mode is on (otherwise just the cache %).
	if (wd.tuiMode === "minimal") {
		const lvl = wd.gameMode ? wd.level ?? 1 : undefined;
		const cachePct = wd.cachePct ?? 0;
		const cacheStr = `${Math.round(cachePct * 10) / 10}%`;
		const accent = themeAnsi(wd.theme, "accent");
		const mega = themeAnsi(wd.theme, "mega");
		const megaFlare =
			wd.gameMode && wd.megaCacheFlare && cachePct >= 100
				? ` ${mega}MEGA CACHE${sgrReset(mega)}`
				: "";
		const body =
			lvl != null
				? `${accent}${wd.gameMode && wd.levelUpFlare ? "\x1b[5m" : ""}LVL ${lvl}${wd.gameMode && wd.levelUpFlare ? "\x1b[0m" : ""}${sgrReset(accent)} ${C.dim}|${C.reset} cache ${cacheStr}${megaFlare}`
				: `cache ${cacheStr}${megaFlare}`;
		return [
			effectBar(panelBar(width, "─", panelBg), borderSgr),
			panelLine(` ${body}`, width, panelBg),
			effectBar(panelBar(width, "─", panelBg), borderSgr),
		];
	}
	const pulse = wd.pulsing
		? `${C.cyan}${PULSE[Math.floor(Date.now() / 250) % PULSE.length]}${C.reset} `
		: "";
	const sep = ` ${C.dim}│${C.reset} `;
	// S31: game-mode header prefix — `LVL n` (accent) prepended to content[0],
	// and a MEGA CACHE flare (mega ansi) + oopsie gag appended when armed. Both
	// hidden when game mode is off (keeps the legacy panel byte-for-byte).
	const lvlPrefix = wd.gameMode
		? `${themeAnsi(wd.theme, "accent")}${wd.gameMode && wd.levelUpFlare ? "\x1b[5m" : ""}LVL ${wd.level ?? 1}${wd.gameMode && wd.levelUpFlare ? "\x1b[0m" : ""}${sgrReset(themeAnsi(wd.theme, "accent"))} `
		: "";
	const megaFlareSuffix =
		wd.gameMode && wd.megaCacheFlare && (wd.cachePct ?? 0) >= 100
			? `${sep}${themeAnsi(wd.theme, "mega")}MEGA CACHE! (oops, you cached so hard the dedup caught fire)${sgrReset(themeAnsi(wd.theme, "mega"))}`
			: "";
	// Build one long content line — let terminal wrap it naturally
	const content = [
		`${lvlPrefix}${C.amber}⚡ ${wd.tierLabel}${C.reset} v${C.bold}${wd.version}${C.reset} ${ramp(wd.ctxPct, 20)} ${C.bold}${wd.pctStr}${C.reset} ${wd.tokStr}/${wd.maxStr}${megaFlareSuffix}`,
		wd.triggerLabel,
		`${C.cyan}${wd.modelStr}${C.reset}`,
		`${wd.chk} chk${wd.agentStr}${wd.turnStr}`,
		`${C.magenta}dup ${wd.dedupStr}${C.reset}`,
		`${C.gray}sess${C.reset} ${fmtTokens(wd.sessIn)}→${fmtTokens(wd.sessKept)} kept ${C.green}(${wd.sTxt}% freed)${C.reset}`,
		`${C.gray}all-time${C.reset} ${fmtTokens(wd.repoIn)}→${fmtTokens(wd.repoKept)} kept ${C.blue}(${wd.rTxt}% freed)${C.reset}`,
		`${wd.repoChk} chk/${wd.repoSess} sess`,
		`${C.gray}mem${C.reset} ${wd.embedderName} · ${wd.chk} chunks · ${C.blue}comp ${wd.compStr}${C.reset}`,
		`${C.gray}drift${C.reset} ${wd.driftStatus === "ok" ? C.green : C.amber}${wd.driftStatus}${C.reset}`,
		`${C.gray}compact${C.reset} ${sinceCompactStr(wd.sinceCompact)}`,
	].join(sep);
	// Wrap to terminal width and pad each line
	const wrapped = wrapLine(content, width - 2, panelBg); // 2-char indent
	const lines: string[] = [
		effectBar(panelBar(width, "─", panelBg), borderSgr),
		...wrapped.map((l) => panelLine(l, width, panelBg)),
	];
	// L4 — agents block (S27, count + status; per-agent tokens gated on P0)
	if (wd.agentsActive) {
		lines.push(
			panelLine(
				`   ${C.cyan}🤖 ${activeAgents} active${wd.turnStr}${C.reset}`,
				width,
				panelBg,
			),
		);
	}
	// L5 — live ticker / activity (♻ deduped … why, or tier trace, or pulsing)
	if (wd.tierTrace && wd.fresh) {
		lines.push(panelLine(`   ${pulse}${wd.tierTrace}`, width, panelBg));
	} else if (wd.ticker.length > 0) {
		const step = Math.floor(Date.now() / 250);
		const idx = wd.ticker.length - 1 - (step % wd.ticker.length);
		const head = wd.ticker[idx].text;
		const why = wd.lastWhy ? ` ${C.gray}· ${wd.lastWhy}${C.reset}` : "";
		const more =
			wd.ticker.length > 1
				? ` ${C.dim}(+${wd.ticker.length - 1} more)${C.reset}`
				: "";
		lines.push(
			panelLine(
				`   ${wd.fresh ? C.teal : C.dim}${head}${why}${more}${C.reset}`,
				width,
				panelBg,
			),
		);
	} else if (wd.pulsing) {
		lines.push(panelLine(`   ${pulse}${C.teal}compacting…${C.reset}`, width, panelBg));
	}
	// S35: achievement-unlock toast (one-line, accent) -- fires for one render cycle.
	if (wd.gameMode && wd.achievementFlare && wd.achievementFlareTitles?.length) {
		const accentSgr = themeAnsi(wd.theme, "accent");
		const titlesStr = wd.achievementFlareTitles.join(", ");
		lines.push(panelLine(`   ${accentSgr}🏆 Achievement unlocked: ${titlesStr}${sgrReset(accentSgr)}`, width, panelBg));
	}
	// bottom border
	lines.push(effectBar(panelBar(width, "─", panelBg), borderSgr));
	return lines;
}
