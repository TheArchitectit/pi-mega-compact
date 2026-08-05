import type React from "react";
import type { VectorCortexPolicyView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Metric } from "./VectorCortexMetric";
import { VcStatusBadge } from "./VcStatusBadge";

export function VectorCortexPolicyCard({ view }: { view: VectorCortexPolicyView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Shadow Adaptive Policy (VC8B)</CardTitle>
					<VcStatusBadge status={view?.status} />
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Shadow adaptive policy disabled (VC8B off) — no shadow decisions are reported, so the live path uses the predecessor thresholds (mode C). The policy, shadow, and M7 migration arithmetic still run; only this reporting seam is suppressed.</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Shadow decisions" value={String(view.shadowDecisions)} />
							<Metric label="Clamped" value={String(view.clampedDecisions)} />
							<Metric label="Rejected inputs" value={String(view.rejectedInputs)} />
							<Metric label="Live mutations" value={String(view.liveMutations)} />
							<Metric label="Pressure version" value={String(view.pressureVersion)} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only shadow adaptive policy — aggregate counts and POL_/M7_ codes only. Policy actions are from a finite set chosen deterministically by the canonical pressure level; budgets are clamped into a configured window after the pressure factor. Unknown pressure labels are rejected as POL_PRESSURE_UNKNOWN, never coerced. The shadow engine is structurally incapable of affecting the live path — inputs are deep-copied and the prompt digest is pinned before and after — so liveMutations is always zero. M7 migrates legacy pressure labels to the v2 canonical five by copy/validate/switch; an unknown label blocks the switch (M7_PRESSURE_UNKNOWN). No prompt bytes, session content, or free-text ever reaches the client.
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
