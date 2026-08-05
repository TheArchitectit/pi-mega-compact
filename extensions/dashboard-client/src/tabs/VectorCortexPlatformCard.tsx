import type React from "react";
import type { VectorCortexPlatformView } from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";

export function VectorCortexPlatformCard({ view }: { view: VectorCortexPlatformView | null }): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Canary Platform + Rust Parity (VC8C)</CardTitle>
					{view?.enabled ? (
						<Badge variant="success">ACTIVE</Badge>
					) : (
						<Badge variant="danger">OFF</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{!view?.enabled ? (
					<div className="vc-empty">Canary platform disabled (VC8C off) — no engine parity checks are reported, so the selection stays at the predecessor (mode C). The selector and cross-conformance runner arithmetic still run; only this reporting seam is suppressed.</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="Mode" value={view.mode} />
							<Metric label="Fixtures" value={String(view.fixtureCount)} />
							<Metric label="Passed" value={String(view.passed)} />
							<Metric label="Failed" value={String(view.failed)} />
							<Metric label="External runner" value={view.externalRunnerConfigured ? "configured" : "none"} />
							<Metric label="Last failure" value={view.lastFailure ?? "none"} />
							<Metric label="Updated" value={view.updatedAt} />
						</div>
						<div className="mt-3 text-xs text-muted-foreground">
							Reader-only canary selection and external Rust parity — aggregate counts and RUST_ codes only. The selector admits a qualified external Rust artifact only when ABI version, URL metadata, commit, Cargo.lock digest, and platform all match evidence; otherwise it demotes to TS reference (mode B) or legacy (mode C). The cross-conformance runner exchanges length-framed neutral records over a local stdin/stdout channel (no network). No artifact bytes, output bytes, or free-text ever reaches the client.
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
