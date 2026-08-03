/**
 * SetupTab/RagHealthCard.tsx — mini RAG health summary for the Overview tab
 * (H3.2). Shows pass rate, avg lift, and an on/off indicator dot, fetched
 * inline from /api/rag-metrics.
 *
 * PREVENT-PI-004: relative-path fetch to the same-origin dashboard server.
 */

import type React from "react";
import { useMemo } from "react";
import { useApi } from "../../hooks/useApi";
import { fetchRagMetrics } from "../../api/client";
import type { RagMetricsResponse } from "@contracts";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/card";

export const RagHealthCard: React.FC = () => {
	const { data: m } = useApi<RagMetricsResponse>(
		useMemo(() => () => fetchRagMetrics(), []),
		{ pollInterval: 30_000 },
	);

	if (!m) {
		return (
			<Card>
				<CardContent className="text-sm text-muted-foreground">Loading RAG health…</CardContent>
			</Card>
		);
	}

	const { totals, flags } = m;
	const active = flags.hydeEnabled || flags.recallMetricsEnabled;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<span
						className={`inline-block h-2 w-2 rounded-full ${active ? "bg-success" : "bg-muted-foreground"}`}
						aria-hidden="true"
					/>
					RAG Health
				</CardTitle>
			</CardHeader>
			<CardContent>
				{!active ? (
					<div className="text-sm text-muted-foreground">
						All RAG recall feature flags are off.
					</div>
				) : (
					<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
						<div>
							<dt className="text-xs text-muted-foreground">Pass rate</dt>
							<dd className="font-semibold text-foreground">
								{Math.round(totals.recentPassRate * 100)}%
							</dd>
						</div>
						<div>
							<dt className="text-xs text-muted-foreground">Avg lift</dt>
							<dd className="font-semibold text-foreground">
								{totals.avgLift.toFixed(2)}×
							</dd>
						</div>
						<div>
							<dt className="text-xs text-muted-foreground">Telemetry turns</dt>
							<dd className="font-semibold text-foreground">{totals.telemetryTurns}</dd>
						</div>
						<div>
							<dt className="text-xs text-muted-foreground">HyDE ran</dt>
							<dd className="font-semibold text-foreground">{totals.hydeRanTurns}</dd>
						</div>
					</dl>
				)}
			</CardContent>
		</Card>
	);
};

export default RagHealthCard;
