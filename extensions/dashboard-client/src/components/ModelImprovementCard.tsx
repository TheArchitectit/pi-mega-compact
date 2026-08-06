/**
 * ModelImprovementCard.tsx — ML5-D "Model Improvement" sub-panel.
 *
 * Sits below the Vector Cortex health card. Shows the current encoder mode,
 * asset digest, and qualification verdict, plus a single "Improve" button that
 * launches the local ML5-A training pipeline (POST /api/cortex/improve, guarded
 * by window.confirm mirroring the server's confirm:true), then polls the job to
 * a terminal Promoted (qualified) / Rejected (demoted_to_B) badge. Aggregate
 * values only — never message content or corpus rows (EVAL-REDACT-002).
 */
import type React from "react";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Metric } from "../tabs/VectorCortexMetric";
import {
	improveCortex,
	fetchCortexImproveStatus,
} from "../api/client-extra";
import type { CortexImproveStatus } from "../types/cortex-improve";

interface Props {
	encoderMode: "A" | "B" | "C";
	encoderAssetDigest: string | null;
	/** deriveVcStatus of the surrounding vector-cortex aggregate (optional). */
	status?: "live" | "awaiting_data" | "deferred" | "structural" | "off";
}

type JobView =
	| { state: "idle" }
	| { state: "improving"; progress: number; jobId: string }
	| { state: "promoted"; digest: string; verdictText: string }
	| { state: "rejected"; reason: string };

export function ModelImprovementCard({
	encoderMode,
	encoderAssetDigest,
	status,
}: Props): React.ReactElement {
	const [job, setJob] = useState<JobView>({ state: "idle" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const poll = (jobId: string) => {
		fetchCortexImproveStatus(jobId)
			.then((s: CortexImproveStatus) => {
				if (s.status === "improving") {
					setJob({ state: "improving", progress: s.progress, jobId });
					window.setTimeout(() => poll(jobId), 2000);
				} else if (s.status === "qualified") {
					setJob({ state: "promoted", digest: s.assetDigest, verdictText: s.verdict.verdict });
				} else {
					setJob({ state: "rejected", reason: s.reason });
				}
				setBusy(false);
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setJob({ state: "idle" });
				setBusy(false);
			});
	};

	const onImprove = () => {
		if (!window.confirm("Run local ML5-A training and re-qualify the encoder heads? The Improve job is local-only.")) return;
		setBusy(true);
		setError(null);
		improveCortex()
			.then((start) => {
				setJob({ state: "improving", progress: 0, jobId: start.jobId });
				poll(start.jobId);
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setBusy(false);
			});
	};

	const promoBadge =
		job.state === "promoted" ? (
			<Badge variant="success">Promoted</Badge>
		) : job.state === "rejected" ? (
			<Badge variant="danger">Rejected</Badge>
		) : encoderMode === "A" ? (
			<Badge variant="success">Promoted</Badge>
		) : (
			<Badge variant="outline">Idle</Badge>
		);

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>Model Improvement (ML5-D)</CardTitle>
					{promoBadge}
				</div>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
					<Metric label="Encoder mode" value={encoderMode} />
					<Metric
						label="Asset digest"
						value={encoderAssetDigest ? encoderAssetDigest.slice(0, 12) : "none"}
					/>
					<Metric label="Status" value={status ?? "off"} />
					<Metric
						label="Job"
						value={
							job.state === "improving"
								? `${Math.round(job.progress * 100)}%`
								: job.state === "promoted"
									? "promoted"
									: job.state === "rejected"
										? "rejected"
										: "idle"
						}
					/>
				</div>
				{(job.state === "promoted" || job.state === "rejected") && (
					<div className="mt-3 text-xs text-muted-foreground">
						{job.state === "promoted"
							? `Qualified verdict: ${job.verdictText} · asset ${job.digest.slice(0, 12)}`
							: `Demoted to mode B: ${job.reason}`}
					</div>
				)}
				{error && (
					<div className="vc-error mt-2 text-xs">{error}</div>
				)}
				<div className="mt-3">
					<button
						onClick={onImprove}
						disabled={busy || status === "off"}
						className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50"
					>
						{busy ? "Improving…" : "Improve"}
					</button>
				</div>
			</CardContent>
		</Card>
	);
}
