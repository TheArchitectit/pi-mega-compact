/**
 * dashboard-client/src/components/ConfigSummaryCard.tsx — Configuration summary.
 *
 * 7 fields with tooltips (verbatim from html.ts):
 * Tier (live), Preset, Pressure, Threshold, Fast Gate, Auto, Anchor.
 *
 * NOTE: pressure and tierPct are 0–1 fractions at runtime.
 * fastGatePct is 0–100 at runtime.
 */

import type React from "react";

export interface ConfigSummaryCardProps {
	/** Current tier name. */
	tier: string;
	/** Preset tier name. */
	presetTier: string;
	/** Live pressure — 0–1 fraction. */
	pressure: number;
	/** Token threshold. */
	thresholdTokens: number;
	/** Tier percentage — 0–1 fraction (runtime-only field). */
	tierPct?: number;
	/** Context window size. */
	contextWindow: number;
	/** Fast-gate percentage — 0–100. */
	fastGatePct: number;
	/** Whether auto-compaction is enabled. */
	auto: boolean;
	/** Number of anchor user messages. */
	anchorUserMessages: number;
}

function StatRow({
	label,
	value,
	title,
}: {
	label: string;
	value: string;
	title?: string;
}): React.ReactElement {
	return (
		<div className="ov-stat-row">
			<span className="ov-stat-label" title={title}>
				{label}
			</span>
			<span className="ov-stat-value">{value}</span>
		</div>
	);
}

export function ConfigSummaryCard(
	props: ConfigSummaryCardProps,
): React.ReactElement {
	const pressurePct = `${Math.round((props.pressure ?? 0) * 100)}%`;

	let thresholdTxt = props.thresholdTokens.toLocaleString();
	if (props.tierPct != null && props.contextWindow > 0) {
		thresholdTxt += ` (${Math.round(props.tierPct * 100)}% of ${props.contextWindow.toLocaleString()})`;
	}

	return (
		<div className="card config-summary-card">
			<h3>Configuration</h3>
			<StatRow
				label="Tier"
				value={`${props.tier} (live)`}
				title="Live pressure band — climbs low→mega as context fills the window."
			/>
			<StatRow
				label="Preset"
				value={props.presetTier}
				title="The env-resolved base compaction preset (low/medium/high/ultra/mega) that set the token threshold."
			/>
			<StatRow
				label="Pressure"
				value={pressurePct}
				title="Live pressure = currentTokens / threshold — % of the model context window (threshold fires at the tier's % of window)."
			/>
			<StatRow
				label="Threshold"
				value={thresholdTxt}
				title="Compaction threshold = tierPct × model context window — mega-compact trims BELOW pi's native ~80% auto-compact for any model size."
			/>
			<StatRow
				label="Fast Gate"
				value={`${props.fastGatePct}%`}
				title="Fast-gate arming floor — the live trim arms once context passes this % of the window."
			/>
			<StatRow
				label="Auto"
				value={props.auto ? "enabled" : "disabled"}
			/>
			<StatRow
				label="Anchor"
				value={String(props.anchorUserMessages)}
			/>
		</div>
	);
}
