import type React from "react";
import type { VectorCortexDiagnosticsView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexDiagnosticsCard({ view }: { view: VectorCortexDiagnosticsView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Cache Diagnostics &amp; Breakers (VC7C)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Cache diagnostics disabled (VC7C off) — no miss is classified and no cache serve is attested here, so all caches are reported bypassed rather than hit (mode C). The classification and breaker arithmetic still runs; only this reporting seam is suppressed.</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Profile misses" value={String(view.profileMisses)} />
							<Metric label="Range misses" value={String(view.rangeMisses)} />
							<Metric label="Dependency misses" value={String(view.dependencyMisses)} />
							<Metric label="Request misses" value={String(view.requestMisses)} />
							<Metric label="Generation misses" value={String(view.generationMisses)} />
							<Metric label="Unknown misses" value={String(view.unknownMisses)} />
							<Metric label="Serves blocked" value={String(view.serveBlocked)} />
							<Metric label="Breaker" value={view.breakerState} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only cache miss diagnostics — per-class counts and CACHE_*/M5_* codes only. Classification is exclusive and ordered (profile, range, dependency, request, generation, then unknown), so each miss increments exactly one counter. A miss diagnostic would otherwise carry the missed request itself, so request payloads, RequestHashV2 digests, covered ranges, span/covered digests, profile digests, and session ids are never exposed (SECURITY_PRIVACY). Blocked serves are demotions taken BEFORE a cache serve — on key collision, stale generation, digest failure, or profile mismatch — and are reported here only as a count; the breaker cannot be reset from this reader-only surface.
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
