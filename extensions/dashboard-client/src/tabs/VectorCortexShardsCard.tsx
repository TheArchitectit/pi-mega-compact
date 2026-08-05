/**
 * VectorCortexShardsCard.tsx — VC4A dual-tier shard aggregate + VC4C
 * reconstruction-fidelity cards.
 *
 * Extracted verbatim from VectorCortexTab.tsx (delegate-shell + sibling-card
 * pattern already used by VectorCortexRenderCard / VectorCortexRestoreCard) so
 * the tab stays well under the 400-line extension soft limit as later sprints
 * add cards. Both are reader-only count/byte aggregates — no payload.
 */
import type React from "react";
import type {
	VectorCortexReconstructView,
	VectorCortexShardsView,
} from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

/** Reader-only dual-tier shard aggregate (VC4A). */
export function VectorCortexShardsCard({ view }: { view: VectorCortexShardsView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Dual-Tier Shards (VC4A)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Dual-tier shards disabled (VC4A off).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Semantic shards" value={String(view.semanticCount)} />
							<Metric label="Exact shards" value={String(view.exactCount)} />
							<Metric label="Byte total" value={String(view.byteTotal)} />
							<Metric label="Protected bytes" value={String(view.protectedByteTotal)} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only count/byte aggregate; staged in-memory this sprint.
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

/** Reader-only reconstruction-fidelity aggregate (VC4C). */
export function VectorCortexReconstructCard({ view }: { view: VectorCortexReconstructView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Reconstruction Fidelity (VC4C)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Reconstruction fidelity disabled (VC4C off).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Closure attempts" value={String(view.closureAttempts)} />
							<Metric label="Closure rejections" value={String(view.closureRejections)} />
							<Metric label="Validated" value={String(view.validatedCount)} />
							<Metric label="Invalidated" value={String(view.invalidatedCount)} />
							<Metric label="Span total" value={String(view.spanTotal)} />
							<Metric label="Byte total" value={String(view.byteTotal)} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only closure/validation aggregate; staged in-memory this sprint.
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
