/**
 * effects.ts — extracted effect/flare/ticker logic for MegaRuntime.
 *
 * Pure implementations of ambient effects, flare arming, tier-trace callback,
 * and the recall/activity ticker. Each function takes a typed context object so
 * the class methods in state.ts become thin one-line delegates.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { C } from "./widget.js";
import type { TickerEntry } from "./widget.js";

// ---------------------------------------------------------------------- types

export interface EffectsContext {
	// Effect state
	activeEffect: { type: "pulse" | "flash"; role: "accent" | "mega" | "red"; startedAt: number; durationMs: number } | null;
	// Flare state
	megaCacheFlare: boolean;
	megaCacheFlarePct: number;
	achievementFlare: boolean;
	achievementFlareTitles: string[];
	// Tier trace
	tierTrace: string | undefined;
	// Ticker
	ticker: TickerEntry[];
	readonly TICKER_MAX: number;
	lastActivityAt: number;
	// Callback — the tier callback calls snapshot() to trigger a widget refresh
	snapshot(ctx: ExtensionContext): void;
}

// --------------------------------------------------------------- setEffect

/** v0.8.3: arm an ambient border effect (animated pulse/flash on the panel
 *  borders). Replaces any in-flight effect (last call wins). The widget reads
 *  activeEffect each frame and computes the per-frame phase from startedAt vs
 *  Date.now(); it renders '' once the window elapses. */
export function setEffectImpl(
	ctx: EffectsContext,
	type: "pulse" | "flash",
	role: "accent" | "mega" | "red",
	durationMs: number,
): void {
	ctx.activeEffect = { type, role, startedAt: Date.now(), durationMs };
}

// -------------------------------------------------------- armMegaCacheFlare

/** S33: arm the transient MEGA CACHE flare so the next snapshot() copies it
 *  into widgetData and the widget renders the oopsie gag for one cycle.
 *  v0.8.3: also arm a 'flash' ambient effect on the panel borders (mega
 *  color) for 1.2s. */
export function armMegaCacheFlareImpl(ctx: EffectsContext, peakPct: number): void {
	ctx.megaCacheFlare = true;
	ctx.megaCacheFlarePct = peakPct;
	setEffectImpl(ctx, "flash", "mega", 1200);
}

// ------------------------------------------------------ armAchievementFlare

/** S35: arm the transient achievement-unlock flare with the newly-unlocked
 *  titles so the next snapshot() copies them into widgetData and the widget
 *  renders the one-time unlock toast for one render cycle.
 *  v0.8.3: also arm a 'pulse' ambient effect on the panel borders (accent
 *  color) for 2s to celebrate the unlock. */
export function armAchievementFlareImpl(ctx: EffectsContext, titles: string[]): void {
	ctx.achievementFlare = true;
	ctx.achievementFlareTitles = titles;
	setEffectImpl(ctx, "pulse", "accent", 2000);
}

// -------------------------------------------------------- makeTierCallback

/** Build the sync onTier callback that paints the live per-tier trace. */
export function makeTierCallbackImpl(
	ctx: EffectsContext,
	ectx: ExtensionContext,
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
		ctx.tierTrace = `${C.teal}⚙${C.reset} ${show.join(` ${C.gray}→${C.reset} `)}`;
		ctx.lastActivityAt = Date.now();
		try {
			ctx.snapshot(ectx);
		} catch {
			/* non-fatal */
		}
	};
}

// -------------------------------------------------------------- pushTicker

/** Phase 3 — recall/activity ticker ring buffer.
 *  Dedupe consecutive identical entries — skip the append when the last
 *  entry's text matches, so a re-fired compact/recall/dedup event doesn't
 *  flood the ring (keeps it at TICKER_MAX for real variety). `at` is NOT
 *  refreshed on a skip (the original event time stands). */
export function pushTickerImpl(ctx: EffectsContext, text: string): void {
	if (ctx.ticker[ctx.ticker.length - 1]?.text === text) {
		ctx.lastActivityAt = Date.now();
		return;
	}
	ctx.ticker.push({ text, at: Date.now() });
	while (ctx.ticker.length > ctx.TICKER_MAX) ctx.ticker.shift();
	ctx.lastActivityAt = Date.now();
}
