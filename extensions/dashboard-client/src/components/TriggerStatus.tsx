/**
 * dashboard-client/src/components/TriggerStatus.tsx — trigger armed/ready status.
 *
 * Two bullets (armed, ready) + threshold display + fast-gate %.
 */

import type React from "react";

export interface TriggerStatusProps {
	/** Whether the trigger is armed (waiting for threshold). */
	armed: boolean;
	/** Whether the trigger is ready to fire (pressure at/above threshold). */
	ready: boolean;
	/** Current context token count, or null if unknown. */
	currentTokens: number | null;
	/** Token threshold for firing. */
	thresholdTokens: number;
	/** Fast-gate pressure threshold (percent, 0–100). */
	fastGatePct: number;
}

function Bullet({
	on,
	label,
}: {
	on: boolean;
	label: string;
}): React.ReactElement {
	return (
		<div className={`bullet ${on ? "bullet-on" : "bullet-off"}`}>
			<span className="bullet-dot" aria-hidden="true" />
			<span className="bullet-label">{label}</span>
		</div>
	);
}

export function TriggerStatus({
	armed,
	ready,
	currentTokens,
	thresholdTokens,
	fastGatePct,
}: TriggerStatusProps): React.ReactElement {
	const cur =
		currentTokens !== null && currentTokens !== undefined
			? currentTokens.toLocaleString()
			: "unknown";
	return (
		<div className="card trigger-status">
			<h3>Trigger</h3>
			<div className="bullet-row">
				<Bullet on={armed} label="Armed" />
				<Bullet on={ready} label="Ready" />
			</div>
			<p className="trigger-detail">
				Threshold: {thresholdTokens.toLocaleString()} tokens
			</p>
			<p className="trigger-detail">Current: {cur} tokens</p>
			<p className="trigger-detail">Fast gate: {fastGatePct}%</p>
		</div>
	);
}
