/**
 * widget-ansi.ts — the ANSI palette, theme resolution, panel layout helpers,
 * and ambient border-effect helpers extracted from the original widget.ts.
 *
 * Pure rendering primitives with zero runtime-state dependencies. The render
 * function (widget.ts) and the snapshot computation (snapshot.ts) import these;
 * `C` is also re-exported via the widget barrel for mega-pipeline/mega-commands.
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
import type { WidgetData } from "./widget-types.js";

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

export const PULSE = ["◐", "◓", "◑", "◒"];

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
export const DEFAULT_PANEL_BG = "\x1b[48;5;236m"; // dark slate panel background

/** Resolve the panel-background SGR prefix for a theme id. Transparent themes
 *  (bg=null) and unknown themes yield `""` (no bg fill) — the width guard in
 *  panelLine/panelBar still applies via truncateToWidth. */
export function panelBgFor(theme: string | undefined): string {
	if (!theme || theme === DEFAULT_THEME) return "";
	const t = getTheme(theme);
	const bg = t?.ansi.bg;
	return bg ? `\x1b[${bg}m` : "";
}

/** Resolve a theme ANSI accent/mega/fg SGR prefix (`\x1b[<params>m`) for the
 *  given role. Falls back to `""` (no SGR) for transparent/unknown themes so
 *  game-mode text still renders in the default fg without color noise. */
export function themeAnsi(theme: string | undefined, role: "fg" | "accent" | "mega"): string {
	const t = theme ? getTheme(theme) : undefined;
	const params = t?.ansi[role];
	return params ? `\x1b[${params}m` : "";
}

/** Emit a full SGR reset, OR `""` if `sgr` is empty (transparent theme). Keeps
 *  the panel bg continuous by NOT clobbering it with a bare reset when the
 *  accent/mega prefix was a no-op. */
export function sgrReset(sgr: string): string {
	return sgr ? "\x1b[0m" : "";
}

// (Visible-width measurement is delegated to pi-tui's `visibleWidth` — imported
// above — so our width math can never diverge from pi-tui's render-width check.)

/** Wrap a string (with ANSI codes) to fit within `maxWidth` visible chars.
 *  Splits at │ separators or whitespace when possible. */
export function wrapLine(text: string, maxWidth: number, panelBg: string): string[] {
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

export function panelLine(content: string, width: number, panelBg: string = DEFAULT_PANEL_BG): string {
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
export function panelBar(width: number, ch = "─", panelBg: string = DEFAULT_PANEL_BG): string {
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
export const EFFECT_BASE: Record<"accent" | "mega" | "red", number> = {
	accent: 51,
	mega: 214,
	red: 203,
};

/** Resolve the per-frame border-fg SGR for an active effect. '' when idle or
 *  expired (the widget's real per-frame expiry enforcer — snapshot-level clear
 *  is just bookkeeping since snapshot is event-driven). */
export function effectBorderSgr(
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
export function effectBar(bar: string, sgr: string): string {
	return sgr ? sgr + bar : bar;
}

/** Token-count formatter: M at/above 1e6, k at/above 1e3, raw below.
 *  5,472,700 → "5.5mil", 24,100 → "24.1k", 142 → "142". */
export function fmtTokens(x: number): string {
	return x >= 1_000_000
		? `${(x / 1_000_000).toFixed(1)}mil`
		: x >= 1000
			? `${(x / 1000).toFixed(1)}k`
			: `${Math.round(x)}`;
}

/** Retro gradient bar — `w` cells shaded by fill position (green→amber→red).
 *  Used for CONTEXT fill where low=green (room) and high=red (near the limit). */
export function ramp(pct: number, w = 12): string {
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
export function sinceCompactStr(ms: number | null): string {
	if (ms == null) return "never";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
