/**
 * dashboard-client/src/tabs/ReposTab.tsx — Repos tab (C2 fleshed out).
 *
 * Renders: SummaryTiles (4 tiles), All Repositories table (RepoTable),
 * Active Repos table (ActiveReposTable), Savings by Model table
 * (SavingsByModelTable), and per-repo detail modal (RepoDetailModal).
 *
 * Data sources: fetchIndex() for summary + all repos + savings-by-model;
 * fetchServers() for active repos. Both polled every 10s.
 */

import type React from "react";
import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { fetchIndex, fetchServers } from "../api/client";
import type { IndexesIndexRow, ServersResponse } from "@contracts";
import { SummaryTiles } from "../components/SummaryTiles";
import { RepoTable } from "../components/RepoTable";
import { RepoDetailModal } from "../components/RepoDetailModal";
import { ActiveReposTable } from "../components/ActiveReposTable";
import { SavingsByModelTable } from "../components/SavingsByModelTable";

/**
 * Actual runtime shape of /api/index. The contract's IndexesSummaryResponse
 * puts summary fields at the top level, but the real server nests them under
 * `summary` (matching IndexFallbackResponse shape with non-null summary).
 */
interface DashboardIndexSummary {
	totalRepos: number;
	totalCheckpoints: number;
	totalTokensSaved: number;
	totalCompressedOriginalBytes: number;
}

interface DashboardIndexResponse {
	updatedAt: string | null;
	summary: DashboardIndexSummary | null;
	repos: IndexesIndexRow[];
}

/** Fetch /api/index and cast to the actual runtime shape. */
async function fetchIndexTyped(): Promise<DashboardIndexResponse> {
	return (await fetchIndex()) as unknown as DashboardIndexResponse;
}

export default function ReposTab(): React.ReactElement {
	const [selected, setSelected] = useState<IndexesIndexRow | null>(null);

	const { data: indexData, error: indexErr } =
		useApi<DashboardIndexResponse>(
			useCallback(() => fetchIndexTyped(), []),
			{ pollInterval: 10_000 },
		);

	const { data: serversData } = useApi<ServersResponse>(
		useCallback(() => fetchServers(), []),
		{ pollInterval: 10_000 },
	);

	if (indexErr && !indexData) {
		return (
			<div className="tab-stub">Error loading repos: {indexErr.message}</div>
		);
	}
	if (!indexData) {
		return <div className="tab-stub">Loading repos…</div>;
	}

	const summary = indexData.summary;
	const repos = indexData.repos;
	const servers = serversData?.servers ?? [];

	return (
		<div className="repos-tab">
			<SummaryTiles
				totalRepos={summary?.totalRepos ?? 0}
				totalCheckpoints={summary?.totalCheckpoints ?? 0}
				totalTokensSaved={summary?.totalTokensSaved ?? 0}
				compressedOriginalBytes={summary?.totalCompressedOriginalBytes ?? 0}
			/>
			<h2 className="section-header">All Repositories</h2>
			<RepoTable repos={repos} onSelect={setSelected} />
			<h2 className="section-header">
				Active Repos — Live Cache Hits &amp; Compactions
			</h2>
			<ActiveReposTable servers={servers} />
			<h2 className="section-header">Savings by Model</h2>
			<SavingsByModelTable repos={repos} />
			{selected && (
				<RepoDetailModal repo={selected} onClose={() => setSelected(null)} />
			)}
		</div>
	);
}
