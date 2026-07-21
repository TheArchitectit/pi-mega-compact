/**
 * dashboard-client/src/tabs/OverviewTab.tsx — Overview tab (B1 stub).
 *
 * SPRINT-C1: real content — tier, model, context gauge, anchor floor.
 */

import type React from 'react';
import type { SnapshotResponse } from '@contracts';

export interface OverviewTabProps {
  snapshot: SnapshotResponse | null;
  loading: boolean;
  error: Error | null;
}

export default function OverviewTab({ snapshot, loading, error }: OverviewTabProps): React.ReactElement {
  if (loading) return <div className="tab-stub">Loading snapshot…</div>;
  if (error) return <div className="tab-stub">Error: {error.message}</div>;
  if (!snapshot) return <div className="tab-stub">No snapshot data.</div>;

  return (
    <div className="tab-stub">
      <strong>Overview</strong> (B1 stub)
      <p>tier: {snapshot.tier}</p>
      {/* SPRINT-C1-REMAINING: context gauge, anchor floor, model details */}
    </div>
  );
}
