/**
 * dashboard-client/src/components/ContextGauge.tsx — token usage meter.
 *
 * Color-coded percent fill bar: green <60%, yellow 60–80%, red >80%.
 * Sublabel: "{tokens} / {contextWindow} tokens ({percent}%)".
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
	if (percent >= 80) return "gauge-red";
	if (percent >= 60) return "gauge-yellow";
	return "gauge-green";
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function ContextGauge({
	tokens,
	percent,
	contextWindow,
}: ContextGaugeProps): React.ReactElement {
	const pct = percent ?? 0;
	const fillWidth = Math.max(0, Math.min(100, pct));
	const cls = severityClass(pct);
	const label =
		tokens !== null && tokens !== undefined
			? `${formatTokens(tokens)} / ${formatTokens(contextWindow)} tokens (${pct.toFixed(1)}%)`
			: `${formatTokens(contextWindow)} window (usage unknown)`;

	return (
		<div className="card context-gauge">
			<h3>Context</h3>
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
