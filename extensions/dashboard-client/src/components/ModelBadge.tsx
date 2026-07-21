/**
 * dashboard-client/src/components/ModelBadge.tsx — model + provider + rates.
 *
 * Shows the active model name, provider, and input/output rates.
 * Tooltips copied verbatim from html.ts. Used in the Metrics tab header.
 */

import type React from "react";

export interface ModelBadgeProps {
	/** Model name/identifier. */
	name: string;
	/** Human-readable provider name. */
	providerName: string;
	/** Machine-readable provider identifier. */
	provider: string;
	/** USD per input token (from model pricing). */
	inputRate: number;
	/** USD per output token (from model pricing). */
	outputRate: number;
}

function Field({
	label,
	value,
	title,
}: {
	label: string;
	value: string;
	title?: string;
}): React.ReactElement {
	return (
		<div className="model-field" title={title}>
			<span className="model-field-label">{label}</span>
			<span className="model-field-value">{value}</span>
		</div>
	);
}

export function ModelBadge({
	name,
	providerName,
	provider,
	inputRate,
	outputRate,
}: ModelBadgeProps): React.ReactElement {
	const providerDisplay = providerName || provider || "—";
	return (
		<div className="model-badge">
			<Field
				label="Model"
				value={name}
				title="The model pi is currently using — its pricing drives the cost figure."
			/>
			<Field
				label="Provider"
				value={providerDisplay}
				title="The provider serving the model."
			/>
			<Field
				label="Input Rate"
				value={`$${inputRate.toFixed(6)}`}
				title="USD per input token, from the model's pricing."
			/>
			<Field
				label="Output Rate"
				value={`$${outputRate.toFixed(6)}`}
				title="USD per output token, from the model's pricing."
			/>
		</div>
	);
}
