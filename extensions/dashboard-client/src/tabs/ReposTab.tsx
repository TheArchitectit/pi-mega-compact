/**
 * dashboard-client/src/tabs/ReposTab.tsx — Repos tab (C2).
 *
 * Fetches /api/repos + /api/summary. Renders SummaryTiles + RepoTable.
 * Row click opens RepoDetailModal. Polls every 10s.
 */

import type React from "react";
import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { fetchRepos, fetchSummary } from "../api/client";
import type { ReposResponse, SummaryResponse, IndexesIndexRow } from "@contracts";
import { SummaryTiles } from "../components/SummaryTiles";
import { RepoTable } from "../components/RepoTable";
import { RepoDetailModal } from "../components/RepoDetailModal";

export default function ReposTab(): React.ReactElement {
  const [selected, setSelected] = useState<IndexesIndexRow | null>(null);

  const { data: reposResp, error: reposErr } = useApi<ReposResponse>(
    useCallback(() => fetchRepos(), []),
    { pollInterval: 10_000 },
  );
  const { data: summaryResp } = useApi<SummaryResponse>(
    useCallback(() => fetchSummary(), []),
    { pollInterval: 10_000 },
  );

  if (reposErr && !reposResp) {
    return <div className="tab-stub">Error loading repos: {reposErr.message}</div>;
  }
  if (!reposResp) {
    return <div className="tab-stub">Loading repos…</div>;
  }

  const repos = reposResp.repos;
  const summary = summaryResp?.summary;

  return (
    <div className="repos-tab">
      <SummaryTiles
        totalRepos={summaryResp?.totalRepos ?? 0}
        activeRepos={summaryResp?.activeRepos ?? 0}
        totalCheckpoints={summary?.totalCheckpoints ?? 0}
        totalTokensSaved={summary?.totalTokensSaved ?? 0}
      />
      <RepoTable repos={repos} onSelect={setSelected} />
      {selected && (
        <RepoDetailModal repo={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
