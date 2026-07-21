/**
 * dashboard-client/src/components/SummaryTiles.tsx — aggregate header tiles.
 *
 * Total repos, active repos (24h), total checkpoints, total tokens saved.
 */

import type React from 'react';

export interface SummaryTilesProps {
  /** Total repos in the registry. */
  totalRepos: number;
  /** Repos active within the last 24 hours. */
  activeRepos: number;
  /** Total checkpoints across all repos. */
  totalCheckpoints: number;
  /** Total tokens saved across all repos. */
  totalTokensSaved: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function SummaryTiles({
  totalRepos,
  activeRepos,
  totalCheckpoints,
  totalTokensSaved,
}: SummaryTilesProps): React.ReactElement {
  return (
    <div className="summary-tiles">
      <div className="tile">
        <span className="tile-label">Total repos</span>
        <span className="tile-value">{totalRepos.toLocaleString()}</span>
      </div>
      <div className="tile">
        <span className="tile-label">Active (24h)</span>
        <span className="tile-value">{activeRepos.toLocaleString()}</span>
      </div>
      <div className="tile">
        <span className="tile-label">Checkpoints</span>
        <span className="tile-value">{totalCheckpoints.toLocaleString()}</span>
      </div>
      <div className="tile tile-highlight">
        <span className="tile-label">Tokens saved</span>
        <span className="tile-value">{fmt(totalTokensSaved)}</span>
      </div>
    </div>
  );
}
