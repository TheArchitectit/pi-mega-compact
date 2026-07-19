/**
 * widget.ts — above-editor widget rendering helpers (free functions, consts,
 * and interfaces) extracted from the original mega-runtime.ts monolith.
 *
 * These are pure rendering primitives with zero runtime-state dependencies;
 * the `MegaRuntime` class (state.ts) imports them to paint the panel.
 */

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
const PANEL_BG = "\x1b[48;5;236m"; // dark slate panel background
const PANEL_RST = "\x1b[0m" + PANEL_BG; // reset fg but retain panel bg

/** Visible cell width of a string, ignoring ANSI SGR/OSC escapes. */
function visibleWidth(s: string): number {
	const stripped = s
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
	let w = 0;
	for (const ch of stripped) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			cp >= 0x1100 &&
			(cp <= 0x115f ||
				(cp >= 0x2e80 && cp <= 0x303e) ||
				(cp >= 0x3041 && cp <= 0x33ff) ||
				(cp >= 0x3400 && cp <= 0x4dbf) ||
				(cp >= 0x4e00 && cp <= 0x9fff) ||
				(cp >= 0xa000 && cp <= 0xa4cf) ||
				(cp >= 0xac00 && cp <= 0xd7a3) ||
				(cp >= 0xf900 && cp <= 0xfaff) ||
				(cp >= 0xfe30 && cp <= 0xfe4f) ||
				(cp >= 0xff00 && cp <= 0xff60) ||
				(cp >= 0xffe0 && cp <= 0xffe6) ||
				(cp >= 0x1f300 && cp <= 0x1faff) ||
				(cp >= 0x20000 && cp <= 0x3fffd));
		w += wide ? 2 : 1;
	}
	return w;
}

/** Wrap a string (with ANSI codes) to fit within `maxWidth` visible chars.
 *  Splits at │ separators or whitespace when possible. */
function wrapLine(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const result: string[] = [];
	let current = "";
	let currentW = 0;
	// Split at │ boundaries first
	const segments = text.split("│");
	for (let i = 0; i < segments.length; i++) {
		const seg = (i > 0 ? "│" : "") + segments[i];
		const segW = visibleWidth(PANEL_BG + seg.replace(/\x1b\[0m/g, PANEL_RST));
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

function panelLine(content: string, width: number): string {
	const withBg = PANEL_BG + content.replace(/\x1b\[0m/g, PANEL_RST);
	const pad = Math.max(0, width - visibleWidth(withBg));
	return withBg + " ".repeat(pad) + "\x1b[0m";
}

/** A full-width hairline bar (top/bottom border of the panel). */
function panelBar(width: number, ch = "─"): string {
	return PANEL_BG + ch.repeat(Math.max(0, width)) + "\x1b[0m";
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
	if (!wd) {
		return [
			panelBar(width, "─"),
			panelLine(" mega-compact: warming up…", width),
			panelBar(width, "─"),
		];
	}
	const pulse = wd.pulsing
		? `${C.cyan}${PULSE[Math.floor(Date.now() / 250) % PULSE.length]}${C.reset} `
		: "";
	const sep = ` ${C.dim}│${C.reset} `;
	// Build one long content line — let terminal wrap it naturally
	const content = [
		`${C.amber}⚡ ${wd.tierLabel}${C.reset} v${C.bold}${wd.version}${C.reset} ${ramp(wd.ctxPct, 20)} ${C.bold}${wd.pctStr}${C.reset} ${wd.tokStr}/${wd.maxStr}`,
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
	const wrapped = wrapLine(content, width - 2); // 2-char indent
	const lines: string[] = [
		panelBar(width, "─"),
		...wrapped.map((l) => panelLine(l, width)),
	];
	// L4 — agents block (S27, count + status; per-agent tokens gated on P0)
	if (wd.agentsActive) {
		lines.push(
			panelLine(
				`   ${C.cyan}🤖 ${activeAgents} active${wd.turnStr}${C.reset}`,
				width,
			),
		);
	}
	// L5 — live ticker / activity (♻ deduped … why, or tier trace, or pulsing)
	if (wd.tierTrace && wd.fresh) {
		lines.push(panelLine(`   ${pulse}${wd.tierTrace}`, width));
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
			),
		);
	} else if (wd.pulsing) {
		lines.push(panelLine(`   ${pulse}${C.teal}compacting…${C.reset}`, width));
	}
	// bottom border
	lines.push(panelBar(width, "─"));
	return lines;
}
