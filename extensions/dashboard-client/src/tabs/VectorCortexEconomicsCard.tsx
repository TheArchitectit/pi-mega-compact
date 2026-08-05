import type React from "react";
import type { VectorCortexEconomicsView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexEconomicsCard({ view }: { view: VectorCortexEconomicsView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Cache Economics (VC7B)</CardTitle>
					{view?.enabled ? (
						<Badge variant="success">ACTIVE</Badge>
					) : (
						<Badge variant="danger">OFF</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Cache economics disabled (VC7B off) — no cache reuse is priced; the cache-economics surface is reported bypassed rather than priced (mode C).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Profiles" value={String(view.profileCount)} />
							<Metric label="Proven exclusions" value={String(view.provenExclusions)} />
							<Metric label="Unproven exclusions" value={String(view.unprovenExclusions)} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only cache-economics diagnostics — counts and ECON_* codes only. Cache economics price a frozen rendered prompt's reuse, so provider prices, covered ranges, span/covered digests, request digests, and session ids are never exposed (SECURITY_PRIVACY). An unproven exclusion (declared without a proving fixture id) is rejected by the exclusion-proof rule and is reported here only as a count.
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
