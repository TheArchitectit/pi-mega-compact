/**
 * dashboard-client/src/components/SessionInfo.tsx — Crew / Agents card.
 *
 * Shows Active Agents, Current Turn, and Status.
 */

import type React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

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
		<Card className="electric-hover">
			<CardHeader>
				<CardTitle>Crew / Agents</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
					<span className="text-xs text-muted-foreground">Active Agents</span>
					<span className="font-semibold">{activeAgents}</span>
				</div>
				<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
					<span className="text-xs text-muted-foreground">Current Turn</span>
					<span className="font-semibold">{currentTurn}</span>
				</div>
				<div className="flex items-baseline justify-between py-1 text-sm">
					<span className="text-xs text-muted-foreground">Status</span>
					<span className="font-semibold">{status}</span>
				</div>
			</CardContent>
		</Card>
	);
}
