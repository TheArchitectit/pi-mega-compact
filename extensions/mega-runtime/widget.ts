/**
 * widget.ts — above-editor widget rendering. Now a thin module that owns the
 * `buildWidgetLines` render function and re-exports the ANSI helpers
 * (widget-ansi.ts) + the interfaces (widget-types.ts) so every existing
 * `import { C, TickerEntry, WidgetData, buildWidgetLines } from "./widget.js"`
 * continues to resolve with no consumer changes.
 *
 * Originally a single ~422-line file; split for the Phase 2 decomposition
 * (see DECOMPOSITION.md). Pure rendering primitives — zero runtime-state
 * dependencies; the `MegaRuntime` class (runtime.ts) imports them to paint the
 * panel.
 */

// Re-export the ANSI palette + layout/effect helpers and the interfaces so the
// barrel (`extensions/mega-runtime.ts` does `export * from "./widget.js"`) and
// every direct consumer keep resolving the same named exports.
export {
	C,
	PULSE,
	DEFAULT_PANEL_BG,
	EFFECT_BASE,
	panelBgFor,
	themeAnsi,
	sgrReset,
	wrapLine,
	panelLine,
	panelBar,
	effectBorderSgr,
	effectBar,
	fmtTokens,
	ramp,
	sinceCompactStr,
} from "./widget-ansi.js";
export type { TickerEntry, WidgetData } from "./widget-types.js";

import {
	C,
	PULSE,
	DEFAULT_PANEL_BG,
	panelBgFor,
	themeAnsi,
	sgrReset,
	wrapLine,
	panelLine,
	panelBar,
	effectBorderSgr,
	effectBar,
	fmtTokens,
	ramp,
	sinceCompactStr,
} from "./widget-ansi.js";
import type { WidgetData } from "./widget-types.js";

// ── buildWidgetLines ───────────────────────────────────────────────────────
// Kept as a free function (not a MegaRuntime method) so runtime.ts stays
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
		const lvl = wd.gameMode ? (wd.level ?? 1) : undefined;
		const cachePct = wd.cachePct ?? 0;
		const cacheStr = `${Math.round(cachePct * 10) / 10}%`;
		const accent = themeAnsi(wd.theme, "accent");
		const mega = themeAnsi(wd.theme, "mega");
		const megaFlare =
			wd.gameMode && wd.megaCacheFlare && (wd.megaCacheFlarePct ?? 0) >= 100
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
		wd.gameMode && wd.megaCacheFlare && (wd.megaCacheFlarePct ?? 0) >= 100
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
		...(wd.perTurnCacheHitPct != null
			? [
					`${C.gray}cache hit${C.reset} this turn ${C.green}${Math.round(wd.perTurnCacheHitPct)}%${C.reset}`,
				]
			: []),
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
		// P1: pin to the most-recent entry (no 250ms rotation). The old
		// `step = floor(Date.now()/250)` re-picked the head every TUI frame,
		// flipping the footer line on a 250·N ms cycle. Pinning makes the
		// footer hold stable until a real state change (new pushTicker /
		// tierTrace / pulsing transition). (+N more) + lastWhy are preserved.
		const idx = wd.ticker.length - 1;
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
		lines.push(
			panelLine(`   ${pulse}${C.teal}compacting…${C.reset}`, width, panelBg),
		);
	}
	// S35: achievement-unlock toast (one-line, accent) -- fires for one render cycle.
	if (wd.gameMode && wd.achievementFlare && wd.achievementFlareTitles?.length) {
		const accentSgr = themeAnsi(wd.theme, "accent");
		const titlesStr = wd.achievementFlareTitles.join(", ");
		lines.push(
			panelLine(
				`   ${accentSgr}🏆 Achievement unlocked: ${titlesStr}${sgrReset(accentSgr)}`,
				width,
				panelBg,
			),
		);
	}
	// bottom border
	lines.push(effectBar(panelBar(width, "─", panelBg), borderSgr));
	return lines;
}
