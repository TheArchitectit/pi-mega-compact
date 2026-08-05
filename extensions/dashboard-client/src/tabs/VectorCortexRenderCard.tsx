import type React from "react";
import type { VectorCortexRenderView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexRenderCard({ view }: { view: VectorCortexRenderView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Validated Prompt Renderer (VC5B)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Renderer disabled (VC5B off).</div>
				) : (
				<>
					<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
						<Metric label="Render fixtures" value={String(view.renderCount)} />
						<Metric label="Provider profiles" value={String(view.providerCount)} />
						<Metric label="Known profiles" value={String(view.knownProfiles.length)} />
					</div>
					<div className="mt-3 text-xs text-muted-foreground">
						Reader-only render conformance route — no prompt text or session payloads exposed.
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
