/**
 * dashboard-client/src/components/SessionInfo.tsx — Crew / Agents card.
 *
 * Shows Active Agents, Current Turn, and Status.
 */

import type React from "react";

export interface SessionInfoProps {
	/** Number of active crew agents. */
	activeAgents: number;
	/** Current turn index in the crew round-robin. */
	currentTurn: number;
}

export function SessionInfo(
	props: SessionInfoProps,
): React.ReactElement {
	const { activeAgents, currentTurn } = props;
	const status =
		activeAgents > 0 ? `▶ ${activeAgents} running` : "idle";

	return (
		<div className="card crew-card">
			<h3>Crew / Agents</h3>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Active Agents</span>
				<span className="ov-stat-value">{activeAgents}</span>
			</div>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Current Turn</span>
				<span className="ov-stat-value">{currentTurn}</span>
			</div>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Status</span>
				<span className="ov-stat-value">{status}</span>
			</div>
		</div>
	);
}
