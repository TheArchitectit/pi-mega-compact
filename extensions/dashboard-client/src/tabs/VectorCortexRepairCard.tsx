import type React from "react";
import type { VectorCortexRepairView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexRepairCard({ view }: { view: VectorCortexRepairView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Self-Healing Derived State (VC6C)</CardTitle>
					{view?.enabled ? (
						<Badge variant="success">ACTIVE</Badge>
					) : (
						<Badge variant="danger">OFF</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Self-healing derived state disabled (VC6C off) — no controller detects gaps or rebuilds derived state; derived state is reported disabled rather than healed (mode C).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Repair attempts" value={String(view.repairAttempts)} />
							<Metric label="Repairs planned" value={String(view.repairsPlanned)} />
							<Metric label="Pointers switched" value={String(view.pointersSwitched)} />
							<Metric label="Backoffs" value={String(view.backoffs)} />
							<Metric label="Last backoff" value={view.lastBackoffMs === null ? "none" : `${view.lastBackoffMs}ms`} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only repair diagnostics — counts and HEAL_REPAIR_* codes only. There is no payload endpoint: subsystem source bytes, gap ranges, high-water marks, root digests, and ledger text are never exposed (SECURITY_PRIVACY).
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
