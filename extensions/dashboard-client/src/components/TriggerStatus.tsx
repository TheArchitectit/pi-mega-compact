/**
 * dashboard-client/src/components/TriggerStatus.tsx — trigger armed/ready status.
 *
 * Two bullets (Armed, Ready) + state text.
 * Ready bullet shows "na" (yellow) when not armed.
 * State text: ready → "THRESHOLD EXCEEDED — compacting next event",
 * armed → "past fast gate — monitoring token count",
 * idle → "idle — below fast gate".
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

type BulletState = "on" | "off" | "na";

function Bullet({
	state,
	label,
}: {
	state: BulletState;
	label: string;
}): React.ReactElement {
	const cls =
		state === "on" ? "bullet-on" : state === "na" ? "bullet-na" : "bullet-off";
	return (
		<div className={`bullet ${cls}`}>
			<span className="bullet-dot" aria-hidden="true" />
			<span className="bullet-label">{label}</span>
		</div>
	);
}

export function TriggerStatus({
	armed,
	ready,
}: TriggerStatusProps): React.ReactElement {
	// tr-armed: on if armed, off if not
	// tr-ready: on if ready, na (yellow) if not armed, off if armed but not ready
	const armedState: BulletState = armed ? "on" : "off";
	const readyState: BulletState = ready
		? "on"
		: !armed
			? "na"
			: "off";

	const stateText = ready
		? "THRESHOLD EXCEEDED — compacting next event"
		: armed
			? "past fast gate — monitoring token count"
			: "idle — below fast gate";

	return (
		<div className="card trigger-status">
			<h3>Trigger Status</h3>
			<div className="bullet-row">
				<Bullet state={armedState} label="Armed" />
				<Bullet state={readyState} label="Ready" />
			</div>
			<p className="trigger-state-text">{stateText}</p>
		</div>
	);
}
