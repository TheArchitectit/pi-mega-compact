/**
 * dashboard-client/src/tabs/OverviewTab.tsx — Overview tab (full spec).
 *
 * Renders all 11 cards from the spec:
 *  1. Context Window (ContextGauge)
 *  2. Trigger Status (TriggerStatus)
 *  3. Vector Store (session) (VectorStoreCard)
 *  4. Repo (all sessions) (RepoAllSessionsCard)
 *  5. Data Safety (DataSafetyCard)
 *  6. Configuration (ConfigSummaryCard)
 *  7. Model & Cost Savings (CacheStatusPerModel)
 *  8. Crew / Agents (SessionInfo)
 *  9. Cache Hits & Compactions (CacheHitsCard)
 * 10. Time Saved (TimeSavedCard)
 * 11. Legend (LegendCard)
 *
 * All data comes from the snapshot prop passed by App.tsx.
 */

import type React from "react";
import type { SnapshotResponse } from "@contracts";
import type { RuntimeSnapshot } from "../utils/types";
import { ContextGauge } from "../components/ContextGauge";
import { TriggerStatus } from "../components/TriggerStatus";
import { VectorStoreCard } from "../components/VectorStoreCard";
import { RepoAllSessionsCard } from "../components/RepoAllSessionsCard";
import { DataSafetyCard } from "../components/DataSafetyCard";
import { ConfigSummaryCard } from "../components/ConfigSummaryCard";
import { CacheStatusPerModel } from "../components/CacheStatusPerModel";
import { SessionInfo } from "../components/SessionInfo";
import { CacheHitsCard } from "../components/CacheHitsCard";
import { TimeSavedCard } from "../components/TimeSavedCard";
import { LegendCard } from "../components/LegendCard";

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

	// Cast to RuntimeSnapshot for tierPct (runtime-only field).
	const d = snapshot as RuntimeSnapshot;
	const { context, compression, trigger, session, store, tier, updatedAt } =
		d;
	const cfg = d.config;
	const crew = d.crew;
	const integrity = d.integrity;
	const cacheHits = d.cacheHits;
	const compacts = d.compacts;
	const timeSaved = d.timeSaved;
	const repo = d.repo;
	const model = d.model;

	return (
		<div className="overview-tab">
			<div className="overview-header">
				<span className="tier-pill">{tier}</span>
				<span className="updated">updated {formatUpdatedAt(updatedAt)}</span>
			</div>
			<div className="card-grid overview-card-grid">
				<ContextGauge
					tokens={context.tokens}
					percent={context.percent}
					contextWindow={context.contextWindow}
				/>
				<TriggerStatus
					armed={trigger.armed}
					ready={trigger.ready}
					currentTokens={trigger.currentTokens}
					thresholdTokens={trigger.thresholdTokens}
					fastGatePct={trigger.fastGatePct}
				/>
				<VectorStoreCard
					checkpointCount={store.checkpointCount}
					tokensIn={compression.session.tokensIn}
					tokensOut={compression.session.tokensOut}
					tokensFreed={compression.session.tokensFreed}
					injectedCount={store.injectedCount}
					dedupHitRate={store.dedupHitRate}
					storageDedupRate={store.storageDedupRate}
					dedupCollapsed={store.dedupCollapsed}
					lastCheckpointId={session.lastCheckpointId}
					compressionPct={compression.session.compressionPct}
					dedupPct={compression.session.dedupPct}
				/>
				<RepoAllSessionsCard
					checkpointCount={repo.checkpointCount}
					tokensIn={compression.repo.tokensIn}
					tokensOut={compression.repo.tokensOut}
					tokensFreed={compression.repo.tokensFreed}
					sessionCount={repo.sessionCount}
					dedupCollapsed={repo.dedupCollapsed}
					storageDedupRate={repo.storageDedupRate}
					compressionPct={compression.repo.compressionPct}
					dedupPct={compression.repo.dedupPct}
				/>
				<DataSafetyCard
					regionsRetained={integrity.regionsRetained}
					compressedOriginalBytes={integrity.compressedOriginalBytes}
					duplicatesCollapsed={integrity.duplicatesCollapsed}
					bytesPermanentlyDeleted={integrity.bytesPermanentlyDeleted}
				/>
				<ConfigSummaryCard
					tier={tier}
					presetTier={d.presetTier}
					pressure={d.pressure}
					thresholdTokens={cfg.thresholdTokens}
					tierPct={cfg.tierPct}
					contextWindow={context.contextWindow}
					fastGatePct={cfg.fastGatePct}
					auto={cfg.auto}
					anchorUserMessages={cfg.anchorUserMessages}
				/>
				{model && (
					<CacheStatusPerModel
						name={model.name}
						provider={model.providerName || model.provider}
						inputRate={model.inputRate}
						outputRate={model.outputRate}
						repoTokensFreed={compression.repo.tokensFreed}
						contextWindow={context.contextWindow}
					/>
				)}
				<SessionInfo
					activeAgents={crew.activeAgents}
					currentTurn={crew.currentTurn}
				/>
				<CacheHitsCard
					cacheHitsSession={cacheHits.session}
					cacheHitsTotal={cacheHits.total}
					tokensSavedSession={cacheHits.sessionTokensSaved}
					tokensSavedTotal={cacheHits.totalTokensSaved}
					compactionsSession={compacts.session}
					compactionsTotal={compacts.total}
				/>
				<TimeSavedCard
					compactSessionSec={timeSaved.compact.sessionSec}
					compactTotalSec={timeSaved.compact.totalSec}
					cacheHitSessionSec={timeSaved.cacheHit.sessionSec}
					cacheHitTotalSec={timeSaved.cacheHit.totalSec}
				/>
				<LegendCard />
			</div>
		</div>
	);
}
