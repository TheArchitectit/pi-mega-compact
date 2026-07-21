/**
 * dashboard-client/src/components/SessionInfo.tsx — session state + store metrics.
 *
 * State badge, checkpoint count, tokens saved, dedup hit rate.
 */

import type React from "react";

export interface SessionInfoProps {
	/** Session lifecycle state, or null when no session is active. */
	state: string | null;
	/** Whether a checkpoint has been persisted during this session. */
	persistedThisSession: boolean;
	/** Total checkpoints across all sessions. */
	checkpointCount: number;
	/** Total tokens saved through compaction. */
	tokensSaved: number;
	/** Dedup hit rate (percent, 0–100). */
	dedupHitRate: number;
}

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function SessionInfo({
	state,
	persistedThisSession,
	checkpointCount,
	tokensSaved,
	dedupHitRate,
}: SessionInfoProps): React.ReactElement {
	const badge = state ?? "no session";
	return (
		<div className="card session-info">
			<h3>Session</h3>
			<p>
				<span
					className={`state-badge state-${(state ?? "none").toLowerCase()}`}
				>
					{badge}
				</span>
				{persistedThisSession && (
					<span className="persisted-tag">persisted</span>
				)}
			</p>
			<div className="stat-grid">
				<div className="stat">
					<span className="stat-label">Checkpoints</span>
					<span className="stat-value">{checkpointCount.toLocaleString()}</span>
				</div>
				<div className="stat stat-highlight">
					<span className="stat-label">Saved</span>
					<span className="stat-value">{fmt(tokensSaved)}</span>
				</div>
				<div className="stat">
					<span className="stat-label">Dedup hit</span>
					<span className="stat-value">{dedupHitRate.toFixed(1)}%</span>
				</div>
			</div>
		</div>
	);
}
