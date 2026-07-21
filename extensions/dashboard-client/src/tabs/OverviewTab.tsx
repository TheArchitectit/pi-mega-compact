/**
 * dashboard-client/src/tabs/OverviewTab.tsx — Overview tab (C1).
 *
 * 4-card grid: ContextGauge, CompressionCard, TriggerStatus, SessionInfo.
 * Header: tier pill + last updated timestamp. Polls /api/snapshot.
 */

import type React from "react";
import type { SnapshotResponse } from "@contracts";
import { ContextGauge } from "../components/ContextGauge";
import { CompressionCard } from "../components/CompressionCard";
import { TriggerStatus } from "../components/TriggerStatus";
import { SessionInfo } from "../components/SessionInfo";

export interface OverviewTabProps {
	snapshot: SnapshotResponse | null;
	loading: boolean;
	error: Error | null;
}

function formatUpdatedAt(ts: string | null): string {
	if (!ts) return "never";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return ts;
	}
}

export default function OverviewTab({
	snapshot,
	loading,
	error,
}: OverviewTabProps): React.ReactElement {
	if (loading && !snapshot)
		return <div className="tab-stub">Loading snapshot…</div>;
	if (error && !snapshot)
		return <div className="tab-stub">Error: {error.message}</div>;
	if (!snapshot) return <div className="tab-stub">No snapshot data.</div>;

	const { context, compression, trigger, session, store, tier, updatedAt } =
		snapshot;

	return (
		<div className="overview-tab">
			<div className="overview-header">
				<span className="tier-pill">{tier}</span>
				<span className="updated">updated {formatUpdatedAt(updatedAt)}</span>
			</div>
			<div className="card-grid">
				<ContextGauge
					tokens={context.tokens}
					percent={context.percent}
					contextWindow={context.contextWindow}
				/>
				<CompressionCard
					tokensIn={compression.repo.tokensIn}
					tokensOut={compression.repo.tokensOut}
					tokensFreed={compression.repo.tokensFreed}
					compressionPct={compression.repo.compressionPct}
					dedupPct={compression.repo.dedupPct}
				/>
				<TriggerStatus
					armed={trigger.armed}
					ready={trigger.ready}
					currentTokens={trigger.currentTokens}
					thresholdTokens={trigger.thresholdTokens}
					fastGatePct={trigger.fastGatePct}
				/>
				<SessionInfo
					state={session.state}
					persistedThisSession={session.persistedThisSession}
					checkpointCount={store.checkpointCount}
					tokensSaved={store.tokensSaved}
					dedupHitRate={store.dedupHitRate}
				/>
			</div>
		</div>
	);
}
