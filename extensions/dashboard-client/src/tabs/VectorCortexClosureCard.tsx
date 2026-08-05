import type React from "react";
import type { VectorCortexClosureProofView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexClosureCard({ view }: { view: VectorCortexClosureProofView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Closure Optimization (VC6A)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Closure optimization disabled (VC6A off) — conservative VC4C closure used directly (mode B).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Optimizations" value={String(view.optimizations)} />
							<Metric label="Proof rejections" value={String(view.proofRejections)} />
							<Metric
								label="Last rejection"
								value={view.lastRejection ?? "none"}
							/>
							<Metric label="Retained edges" value={String(view.retainedEdgeTotal)} />
							<Metric label="Removed edges" value={String(view.removedEdgeTotal)} />
							<Metric label="Conservative walks" value={String(view.conservativeTraversalTotal)} />
							<Metric label="Optimized walks" value={String(view.optimizedTraversalTotal)} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only closure diagnostics — aggregate counts only; per-edge proof rows, node ids, and source payloads are never exposed (SECURITY_PRIVACY).
						</div>
						{view?.status === "awaiting_data" && (
							<div className="mt-2 text-xs text-muted-foreground">
								Awaiting first event. Data will appear after the next pipeline run.
							</div>
						)}
						{view?.status === "deferred" && view?.deferredReason && (
							<div className="mt-2 text-xs text-muted-foreground">
								Deferred: {view.deferredReason.replace(/_/g, " ")}
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
