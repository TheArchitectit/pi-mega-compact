/**
 * dashboard-client/src/components/ContextGauge.tsx — token usage meter.
 *
 * Color-coded percent fill bar: green <70%, yellow 70–89%, red ≥90%.
 * Sublabel: "{tokens} / {contextWindow} tokens".
 * Shows percentage as "{pct}%" in the header.
 */

import type React from "react";

export interface ContextGaugeProps {
	/** Current token count in the context window, or null if unknown. */
	tokens: number | null;
	/** Context window usage percent (0–100), or null if unknown. */
	percent: number | null;
	/** Maximum context window size for the active model. */
	contextWindow: number;
}

function severityClass(percent: number): string {
	if (percent >= 90) return "gauge-red";
	if (percent >= 70) return "gauge-yellow";
	return "gauge-green";
}

export function ContextGauge({
	tokens,
	percent,
	contextWindow,
}: ContextGaugeProps): React.ReactElement {
	const pct = percent ?? 0;
	const fillWidth = Math.max(pct, 1);
	const cls = severityClass(pct);
	const tokStr =
		tokens !== null && tokens !== undefined
			? tokens.toLocaleString()
			: "?";
	const label = `${tokStr} / ${contextWindow.toLocaleString()} tokens`;

	return (
		<div className="card context-gauge">
			<h3>Context Window — {pct}%</h3>
			<div
				className={`gauge-bar ${cls}`}
				role="meter"
				aria-valuenow={pct}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<div className="gauge-fill" style={{ width: `${fillWidth}%` }} />
			</div>
			<p className="gauge-label">{label}</p>
		</div>
	);
}
