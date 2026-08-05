import type React from "react";
import type { VectorCortexPlansView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexPlansCard({ view }: { view: VectorCortexPlansView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Plan Manifests (VC5A)</CardTitle>
					{view?.enabled ? (
						<Badge variant="success">ACTIVE</Badge>
					) : (
						<Badge variant="danger">OFF</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">PromptDagV1 + budgeted planner disabled (VC5A off).</div>
				) : (
				<>
					<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
						<Metric label="DAG fixtures" value={String(view.dagCount)} />
						<Metric label="Plan fixtures" value={String(view.plannerCount)} />
						<Metric label="Plans exposed" value={String(view.plans.length)} />
					</div>
					<div className="mt-3 text-xs text-muted-foreground">
						Reader-only plan manifests only — no session payloads or prompt text.
						Per-run plan outputs are staged in-memory this sprint.
					</div>
				</>
				)}
			</CardContent>
		</Card>
	);
}
