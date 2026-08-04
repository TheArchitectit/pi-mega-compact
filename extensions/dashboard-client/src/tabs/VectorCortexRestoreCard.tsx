import type React from "react";
import type { VectorCortexRestoreView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexRestoreCard({ view }: { view: VectorCortexRestoreView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Exact Source Restoration (VC6B)</CardTitle>
					{view?.enabled ? (
						<Badge variant="success">ACTIVE</Badge>
					) : (
						<Badge variant="danger">OFF</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Exact source restoration disabled (VC6B off) — no exact source is restored; omitted context is disclosed as loss (mode C).</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Restore attempts" value={String(view.restoreAttempts)} />
							<Metric label="Restored" value={String(view.restoredCount)} />
							<Metric label="Missing source" value={String(view.missingCount)} />
							<Metric label="Digest rejections" value={String(view.digestRejections)} />
							<Metric label="Last rejection" value={view.lastRejection ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only restore diagnostics — counts and HEAL_RESTORE_* codes only. There is no payload endpoint: restored bytes, span ids, node ids, and ledger text are never exposed (SECURITY_PRIVACY).
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
