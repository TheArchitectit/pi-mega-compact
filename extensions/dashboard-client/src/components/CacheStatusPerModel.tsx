/**
 * dashboard-client/src/components/CacheStatusPerModel.tsx — Model & Cost Savings card.
 *
 * Shows $ saved, context-windows extended, Model, Provider, Input Rate, Output Rate.
 * Tooltips copied verbatim from html.ts.
 */

import type React from "react";

export interface ModelCostCardProps {
	/** Model name. */
	name: string;
	/** Provider display name (providerName fallback to provider). */
	provider: string;
	/** USD per input token. */
	inputRate: number;
	/** USD per output token. */
	outputRate: number;
	/** Tokens freed (repo-level) used for cost calc. */
	repoTokensFreed: number;
	/** Context window size used for windows calc. */
	contextWindow: number;
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

export function CacheStatusPerModel(
	props: ModelCostCardProps,
): React.ReactElement {
	const repoSaved = props.repoTokensFreed || 0;
	let usd = 0;
	let windows = "0";

	if (props.inputRate && repoSaved > 0) {
		usd = repoSaved * props.inputRate;
		const win = props.contextWindow || 0;
		windows = win > 0 ? (repoSaved / win).toFixed(1) : "0";
	}

	const usdStr = `≈ $${usd.toFixed(4)} saved`;
	const windowsStr = `${windows} context-windows extended`;

	return (
		<div className="card model-cost-card">
			<h3>💰 Model &amp; Cost Savings</h3>
			<div className="ov-cost-usd">{usdStr}</div>
			<div className="ov-cost-sub">{windowsStr}</div>
			<StatRow
				label="Model"
				value={props.name}
				title="The model pi is currently using — its pricing drives the cost figure."
			/>
			<StatRow
				label="Provider"
				value={props.provider}
				title="The provider serving the model."
			/>
			<StatRow
				label="Input Rate"
				value={`$${props.inputRate.toFixed(6)}`}
				title="USD per input token, from the model's pricing."
			/>
			<StatRow
				label="Output Rate"
				value={`$${props.outputRate.toFixed(6)}`}
				title="USD per output token, from the model's pricing."
			/>
		</div>
	);
}
