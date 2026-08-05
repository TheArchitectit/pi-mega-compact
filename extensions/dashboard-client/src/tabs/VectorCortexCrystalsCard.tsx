import type React from "react";
import type { VectorCortexCrystalsView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexCrystalsCard({ view }: { view: VectorCortexCrystalsView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Frozen Range Crystals (VC7A)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Frozen range crystals disabled (VC7A off) — nothing is served from the crystal cache and every render is produced fresh; the cache is reported bypassed rather than hit (mode C).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Crystals" value={String(view.crystalCount)} />
							<Metric label="Frozen bytes" value={String(view.totalBytes)} />
							<Metric label="Hits" value={String(view.hits)} />
							<Metric label="Misses" value={String(view.misses)} />
							<Metric label="Hit bytes" value={String(view.hitBytes)} />
							<Metric label="Writes" value={String(view.writes)} />
							<Metric label="Duplicate writes" value={String(view.duplicateWrites)} />
							<Metric label="Collisions" value={String(view.collisions)} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only crystal diagnostics — counts, byte volumes, and CRY_* codes only. A crystal is a frozen rendered prompt, so frozen bytes, covered ranges, span/covered digests, request digests, and session ids are never exposed (SECURITY_PRIVACY). Keys exclude the global ledger frontier, so an unrelated append does not invalidate a crystal; a covered-byte, dependency, renderer, or profile change does. Collisions mean two renders of one identity disagreed — the stored crystal is never overwritten.
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
