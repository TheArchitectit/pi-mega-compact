/**
 * dashboard-client/src/tabs/MetricsTab.tsx — Metrics tab (C2).
 *
 * Fetches /api/perf (rolling-window aggregates) + /api/snapshot (for model).
 * Renders PerfChart + ModelBadge + resource gauges. Polls every 10s.
 */

import type React from "react";
import { useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { fetchPerf, fetchSnapshot } from "../api/client";
import type { PerfResponse, SnapshotResponse } from "@contracts";
import { PerfChart } from "../components/PerfChart";
import { ModelBadge } from "../components/ModelBadge";

export default function MetricsTab(): React.ReactElement {
  const { data: perf, error: perfErr } = useApi<PerfResponse>(
    useCallback(() => fetchPerf({ minutes: 30 }), []),
    { pollInterval: 10_000 },
  );
  const { data: snapshot } = useApi<SnapshotResponse>(
    useCallback(() => fetchSnapshot(), []),
    { pollInterval: 10_000 },
  );

  if (perfErr && !perf) {
    return <div className="tab-stub">Error loading perf: {perfErr.message}</div>;
  }
  if (!perf) {
    return <div className="tab-stub">Loading perf…</div>;
  }

  return (
    <div className="metrics-tab">
      {snapshot?.model && (
        <ModelBadge
          name={snapshot.model.name}
          providerName={snapshot.model.providerName}
          provider={snapshot.model.provider}
          inputRate={snapshot.model.inputRate}
          outputRate={snapshot.model.outputRate}
        />
      )}
      <PerfChart perf={perf} />
    </div>
  );
}
