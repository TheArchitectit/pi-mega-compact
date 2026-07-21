/**
 * dashboard-client/src/tabs/ConfigTab.tsx — Config tab (C3).
 *
 * Full configuration editor:
 *  (1) Game mode toggle (checkbox)
 *  (2) Theme selector (dropdown) from src/config/themes.ts THEMES array
 *  (3) TUI mode selector (Full/Minimal dropdown)
 *  (4) Read-only config display section from snapshot (Tier, Preset, Pressure,
 *      Threshold, Fast Gate, Auto, Anchor) with verbatim tooltips from html.ts.
 *
 * Uses fetchGameState() to load current state, putGameState() to save changes.
 * Polls gameState and snapshot every 5s. Applies theme by setting
 * document.documentElement.dataset.theme.
 */

import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { SnapshotResponse, GameStatePatch } from "@contracts";
import { fetchSnapshot, fetchGameState, putGameState } from "../api/client";
import { THEMES } from "../../../../src/config/themes";

/** Actual flat game state returned by the server (the server returns a flat
 *  { game_mode_on, theme, tui_display_mode } shape, NOT the contract's nested
 *  { config: { enabled, theme, displayMode }, activeRitual } shape). */
interface FlatGameState {
	game_mode_on: boolean;
	theme: string;
	tui_display_mode: "full" | "minimal";
}
type FlatGameStatePatch = Partial<FlatGameState>;

/** Extended snapshot config — the runtime includes tierPct (not in contract). */
interface ConfigExt extends SnapshotResponse["config"] {
	tierPct?: number | null;
}

/* Tooltips copied verbatim from extensions/dashboard-server/html.ts */
const TOOLTIPS = {
	gameMode: "Turn game mode on/off (themes the widget + dashboard)",
	theme: "Visual theme (applies instantly)",
	tuiMode: "TUI widget display density",
	tier: "Live pressure band — climbs low\u2192mega as context fills the window.",
	preset:
		"The env-resolved base compaction preset (low/medium/high/ultra/mega) that set the token threshold.",
	pressure:
		"Live pressure = currentTokens / threshold \u2014 % of the model context window (threshold fires at the tier's % of window).",
	threshold:
		"Compaction threshold = tierPct \u00d7 model context window \u2014 mega-compact trims BELOW pi's native ~80% auto-compact for any model size.",
	fastGate:
		"Fast-gate arming floor \u2014 the live trim arms once context passes this % of the window.",
} as const;

function formatThreshold(
	tokens: number,
	tierPct: number | null | undefined,
	cw: number,
): string {
	let txt = tokens.toLocaleString();
	if (tierPct != null && cw > 0) {
		txt += ` (${Math.round(tierPct * 100)}% of ${cw.toLocaleString()})`;
	}
	return txt;
}

function formatPressure(pressure: number): string {
	/* Runtime sends 0\u20131 fraction despite contract saying 0\u2013100. */
	return `${Math.round((pressure || 0) * 100)}%`;
}

export default function ConfigTab(): React.ReactElement {
	const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
	const [gameState, setGameState] = useState<FlatGameState | null>(null);
	const [saving, setSaving] = useState(false);

	/* Poll snapshot every 5s for config display section. */
	useEffect(() => {
		let active = true;
		const doFetch = async (): Promise<void> => {
			try {
				const s = await fetchSnapshot();
				if (active) setSnapshot(s);
			} catch {
				/* non-fatal */
			}
		};
		void doFetch();
		const timer = setInterval(() => void doFetch(), 5000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);

	/* Poll game state every 5s. */
	useEffect(() => {
		let active = true;
		const doFetch = async (): Promise<void> => {
			try {
				const gs = (await fetchGameState()) as unknown as FlatGameState;
				if (active) {
					setGameState(gs);
					if (gs.theme)
						document.documentElement.dataset.theme = gs.theme;
				}
			} catch {
				/* non-fatal */
			}
		};
		void doFetch();
		const timer = setInterval(() => void doFetch(), 5000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);

	/* PUT a patch to the server immediately on change. */
	const handlePatch = useCallback(async (patch: FlatGameStatePatch) => {
		setSaving(true);
		try {
			const result = (await putGameState(
				patch as unknown as GameStatePatch,
			)) as unknown as FlatGameState;
			setGameState(result);
			if (result.theme)
				document.documentElement.dataset.theme = result.theme;
		} catch {
			/* non-fatal */
		}
		setSaving(false);
	}, []);

	const gmOn = gameState?.game_mode_on ?? false;
	const themeVal = gameState?.theme ?? "transparent";
	const tuiVal = gameState?.tui_display_mode ?? "full";

	const cfg = snapshot?.config as ConfigExt | undefined;
	const cw = snapshot?.context.contextWindow ?? 0;

	return (
		<div className="config-tab">
			<section className="config-settings">
				<h3>Settings</h3>
				<div className="settings-row">
					<label title={TOOLTIPS.gameMode}>
						<input
							type="checkbox"
							checked={gmOn}
							onChange={(e) =>
								handlePatch({ game_mode_on: e.currentTarget.checked })
							}
							disabled={saving}
						/>
						Game Mode
					</label>
				</div>
				<div className="settings-row">
					<label title={TOOLTIPS.theme}>
						Theme
						<select
							value={themeVal}
							onChange={(e) => handlePatch({ theme: e.currentTarget.value })}
							disabled={saving}
						>
							{THEMES.map((t) => (
								<option key={t.id} value={t.id}>
									{t.label}
								</option>
							))}
						</select>
					</label>
				</div>
				<div className="settings-row">
					<label title={TOOLTIPS.tuiMode}>
						TUI Mode
						<select
							value={tuiVal}
							onChange={(e) =>
								handlePatch({
									tui_display_mode: e.currentTarget.value as "full" | "minimal",
								})
							}
							disabled={saving}
						>
							<option value="full">Full</option>
							<option value="minimal">Minimal</option>
						</select>
					</label>
				</div>
			</section>

			<section className="config-display">
				<h3>Configuration</h3>
				<div className="config-grid">
					<div className="config-item">
						<span className="config-label" title={TOOLTIPS.tier}>
							Tier
						</span>
						<span className="config-value">
							{snapshot ? `${snapshot.tier} (live)` : "\u2014"}
						</span>
					</div>
					<div className="config-item">
						<span className="config-label" title={TOOLTIPS.preset}>
							Preset
						</span>
						<span className="config-value">
							{snapshot?.presetTier ?? "\u2014"}
						</span>
					</div>
					<div className="config-item">
						<span className="config-label" title={TOOLTIPS.pressure}>
							Pressure
						</span>
						<span className="config-value">
							{snapshot ? formatPressure(snapshot.pressure) : "\u2014"}
						</span>
					</div>
					<div className="config-item">
						<span className="config-label" title={TOOLTIPS.threshold}>
							Threshold
						</span>
						<span className="config-value">
							{cfg ? formatThreshold(cfg.thresholdTokens, cfg.tierPct, cw) : "\u2014"}
						</span>
					</div>
					<div className="config-item">
						<span className="config-label" title={TOOLTIPS.fastGate}>
							Fast Gate
						</span>
						<span className="config-value">
							{cfg ? `${cfg.fastGatePct}%` : "\u2014"}
						</span>
					</div>
					<div className="config-item">
						<span className="config-label">Auto</span>
						<span className="config-value">
							{cfg ? (cfg.auto ? "enabled" : "disabled") : "\u2014"}
						</span>
					</div>
					<div className="config-item">
						<span className="config-label">Anchor</span>
						<span className="config-value">
							{cfg?.anchorUserMessages ?? "\u2014"}
						</span>
					</div>
				</div>
			</section>
		</div>
	);
}
