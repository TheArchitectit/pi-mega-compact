/**
 * dashboard-client/src/tabs/CacheTab/MetricsCards.tsx — Performance cards (C2),
 * moved VERBATIM from the top-level MetricsTab.tsx.
 *
 * DASH-0c: the Cache+Performance surface absorbs MetricsTab as a Performance
 * section. This file holds the byte-preserved metrics body (the `MetricsCards`
 * component). The standalone `tabs/MetricsTab.tsx` is reduced to a shell that
 * re-exports it (kept for the #metrics deep-link + rollback symmetry). Only the
 * export name changed (MetricsTab → MetricsCards); the render body is otherwise
 * identical.
 *
 * Fetches /api/perf (rolling-window aggregates) + /api/snapshot (for model).
 * Renders ModelBadge + PerfChart + 5 perf cards (latency, throughput, process,
 * snapshot cost, TUI lag proxy). Polls every 10s.
 */

import type React from "react";
import { useCallback } from "react";
import { useApi } from "../../hooks/useApi";
import { fetchPerf, fetchSnapshot } from "../../api/client";
import type { PerfResponse, SnapshotResponse } from "@contracts";
import { NEW_UI } from "../../config";
import { PerfChart } from "../../components/PerfChart";
import { PerfCards } from "../../components/PerfCards";
import { ModelBadge } from "../../components/ModelBadge";
import { RagDashboard } from "../../components/RagDashboard";

export function MetricsCards(): React.ReactElement {
	const { data: perf, error: perfErr } = useApi<PerfResponse>(
		useCallback(() => fetchPerf({ minutes: 30 }), []),
		{ pollInterval: 10_000 },
	);
	const { data: snapshot } = useApi<SnapshotResponse>(
		useCallback(() => fetchSnapshot(), []),
		{ pollInterval: 10_000 },
	);

	if (perfErr && !perf) {
		return (
			<div className="tab-stub">Error loading perf: {perfErr.message}</div>
		);
	}
	if (!perf) {
		return <div className="tab-stub">Loading perf…</div>;
	}

	return (
		<div className="flex flex-col gap-4">
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
			<PerfCards perf={perf} />
			<div className="text-xs text-muted-foreground">
				{perf.sampleCount} samples · updated {perf.updatedAt}
			</div>
			{NEW_UI() && <RagDashboard />}
		</div>
	);
}
