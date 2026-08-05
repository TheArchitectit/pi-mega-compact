import type React from "react";
import type { VectorCortexOutcomesView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexOutcomesCard({ view }: { view: VectorCortexOutcomesView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Consent-Bound Outcomes (VC8A)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Outcome ledger disabled (VC8A off) — no outcomes are appended and no dataset manifests are built, so all learning is bypassed (mode C). The ledger validation, consent evaluation, and manifest builder arithmetic still run; only this reporting seam is suppressed.</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Outcomes" value={String(view.outcomeCount)} />
							<Metric label="Consented sessions" value={String(view.consentedSessions)} />
							<Metric label="Revoked sessions" value={String(view.revokedSessions)} />
							<Metric label="Manifests" value={String(view.manifestCount)} />
							<Metric label="Excluded records" value={String(view.excludedCount)} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only consent-bound outcome ledger — aggregate counts and OUT_ codes only. The outcome ledger carries metrics without payload, so no prompt bytes, response text, free-text, or session content ever reaches the client. Dataset inclusion requires active explicit consent at export time; revocations disappear from future manifests.
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
