import type React from "react";
import type { VectorCortexRolloutView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexRolloutCard({ view }: { view: VectorCortexRolloutView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Live Graduated Rollout (VC5C)</CardTitle>
					{view?.enabled ? (
						<Badge variant="success">ACTIVE</Badge>
					) : (
						<Badge variant="danger">OFF</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Rollout disabled (VC5C off).</div>
				) : (
				<>
					<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
						<Metric label="Gate" value={`${view.gatePct}%`} />
						<Metric label="Exposed buckets" value={String(view.bucketCount)} />
						<Metric label="Total buckets" value={String(view.buckets)} />
						<Metric
							label="Promotion"
							value={view.promotionBlocked ? "FROZEN" : "OPEN"}
						/>
						<Metric label="Events" value={String(view.events)} />
						<Metric label="Sessions" value={String(view.sessions)} />
					</div>
					<div className="mt-3 text-xs text-muted-foreground">
						Reader-only rollout route — no session payloads or bucket→session mappings exposed.
					</div>
				</>
				)}
			</CardContent>
		</Card>
	);
}
