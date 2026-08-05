/**
 * VectorCortexTab.tsx — vector-cortex dashboard tab.
 * VC0A: reader-only aggregate latency histogram + per-mode sample counts from
 * GET /api/vector-cortex/evaluation. VC0C (task 5): live safety envelope health
 * card (breaker state, window/probe/backoff, durable spool frontier/lag) from
 * GET /api/vector-cortex/health plus an admin "reset cooldown" action. Polls
 * every 5s.
 */

import { useState, useEffect, useCallback } from "react";
import {
	fetchVectorCortexEvaluation,
	fetchVectorCortexHealth,
	fetchVectorCortexLedger,
	fetchVectorCortexQuery,
	fetchVectorCortexReconstruct,
	fetchVectorCortexPlans,
	fetchVectorCortexRender,
	fetchVectorCortexRollout,
	fetchVectorCortexClosureProof,
	fetchVectorCortexRestore,
	fetchVectorCortexRepair,
	fetchVectorCortexShards,
	fetchVectorCortexTopology,
	resetVectorCortexBreaker,
	type VectorCortexEvaluationSummary,
	type VectorCortexHealthCard,
	type VectorCortexLedgerView,
	type VectorCortexQueryView,
	type VectorCortexReconstructView,
	type VectorCortexPlansView,
	type VectorCortexRenderView,
	type VectorCortexRolloutView,
	type VectorCortexClosureProofView,
	type VectorCortexRestoreView,
	type VectorCortexRepairView,
	type VectorCortexShardsView,
	type VectorCortexTopologyView,
} from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Metric } from "./VectorCortexMetric";
import { VectorCortexRenderCard } from "./VectorCortexRenderCard";
import { VectorCortexRolloutCard } from "./VectorCortexRolloutCard";
import { VectorCortexClosureCard } from "./VectorCortexClosureCard";
import { VectorCortexRestoreCard } from "./VectorCortexRestoreCard";
import { VectorCortexRepairCard } from "./VectorCortexRepairCard";
import {
	VectorCortexShardsCard,
	VectorCortexReconstructCard,
} from "./VectorCortexShardsCard";
import { VectorCortexPlansCard } from "./VectorCortexPlansCard";
import { VectorCortexTopologyCard } from "./VectorCortexTopologyCard";
import { VectorCortexLedgerCard } from "./VectorCortexLedgerCard";

function ModeChip({ mode, count }: { mode: string; count: number }): React.ReactElement {
	return (
		<div className="flex items-center justify-between border-b border-border/50 py-1 text-sm">
			<span className="text-muted-foreground">Mode {mode}</span>
			<span className="font-mono">{count}</span>
		</div>
	);
}

export default function VectorCortexTab(): React.ReactElement {
	const [data, setData] = useState<VectorCortexEvaluationSummary | null>(null);
	const [err, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [health, setHealth] = useState<VectorCortexHealthCard | null>(null);
	const [resetMsg, setResetMsg] = useState<string | null>(null);
	const [ledger, setLedger] = useState<VectorCortexLedgerView | null>(null);
	const [topology, setTopology] = useState<VectorCortexTopologyView | null>(null);
	const [query, setQuery] = useState<VectorCortexQueryView | null>(null);
	const [shards, setShards] = useState<VectorCortexShardsView | null>(null);
	const [reconstruct, setReconstruct] = useState<VectorCortexReconstructView | null>(null);
	const [plans, setPlans] = useState<VectorCortexPlansView | null>(null);
	const [render, setRender] = useState<VectorCortexRenderView | null>(null);
	const [rollout, setRollout] = useState<VectorCortexRolloutView | null>(null);
	const [closureProof, setClosureProof] = useState<VectorCortexClosureProofView | null>(null);
	const [restore, setRestore] = useState<VectorCortexRestoreView | null>(null);
	const [repair, setRepair] = useState<VectorCortexRepairView | null>(null);

	const poll = useCallback(() => {
		fetchVectorCortexEvaluation()
			.then(setData)
			.catch((e: unknown) =>
				setError(e instanceof Error ? e.message : String(e)),
			)
			.finally(() => setLoading(false));
		fetchVectorCortexHealth().then(setHealth).catch(() => {
			/* health card is best-effort (VC0C) */
		});
		fetchVectorCortexLedger().then(setLedger).catch(() => {
			/* ledger card is best-effort (VC1B) */
		});
		fetchVectorCortexTopology().then(setTopology).catch(() => {
			/* topology card is best-effort (VC3A) */
		});
		fetchVectorCortexQuery().then(setQuery).catch(() => {
			/* query diagnostics card is best-effort (VC3C) */
		});
		fetchVectorCortexShards().then(setShards).catch(() => {
			/* dual-tier shards card is best-effort (VC4A) */
		});
		fetchVectorCortexReconstruct().then(setReconstruct).catch(() => {
			/* reconstruction-fidelity card is best-effort (VC4C) */
		});
		fetchVectorCortexPlans().then(setPlans).catch(() => {
			/* plan manifest card is best-effort (VC5A) */
		});
		fetchVectorCortexRender().then(setRender).catch(() => {
			/* render conformance card is best-effort (VC5B) */
		});
		fetchVectorCortexRollout().then(setRollout).catch(() => {
			/* rollout card is best-effort (VC5C) */
		});
		fetchVectorCortexClosureProof().then(setClosureProof).catch(() => {
			/* closure-optimization card is best-effort (VC6A) */
		});
		fetchVectorCortexRestore().then(setRestore).catch(() => {
			/* exact-source-restoration card is best-effort (VC6B) */
		});
		fetchVectorCortexRepair().then(setRepair).catch(() => {
			/* self-healing derived-state card is best-effort (VC6C) */
		});
	}, []);

	useEffect(() => {
		poll();
		const id = setInterval(poll, 5000);
		return () => clearInterval(id);
	}, [poll]);

	const onReset = () => {
		resetVectorCortexBreaker("provider")
			.then((r) => {
				setResetMsg(
					`Breaker "${r.subsystem}" ${r.state}; evidence retained: ${r.failures} failures / ${r.attempts} attempts`,
				);
				return fetchVectorCortexHealth();
			})
			.then(setHealth)
			.catch((e: unknown) =>
				setResetMsg(e instanceof Error ? e.message : String(e)),
			);
	};

	if (loading && !data)
		return <div className="vc-loading">Loading vector-cortex evaluation…</div>;
	if (err && !data)
		return <div className="vc-error">Error: {err}</div>;
	if (!data)
		return <div className="vc-empty">No evaluation data available.</div>;

	const max = Math.max(1, ...data.histogram.cells, data.histogram.overflow);
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2">
				<h2 className="text-lg font-semibold">Vector Cortex Evaluation</h2>
				{data.enabled ? (
					<Badge variant="warning">OBSERVER PENDING (A)</Badge>
				) : (
					<Badge variant="danger">MODE C (OFF)</Badge>
				)}
			</div>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle>Samples</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-3xl font-bold">{data.samples}</div>
						<div className="mt-2 flex flex-col">
							<ModeChip mode="A" count={data.byMode.A} />
							<ModeChip mode="B" count={data.byMode.B} />
							<ModeChip mode="C" count={data.byMode.C} />
						</div>
					</CardContent>
				</Card>

				<Card className="md:col-span-2">
					<CardHeader>
						<CardTitle>Latency Histogram (ms, inclusive edges)</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex items-end gap-2" style={{ height: 160 }}>
							{data.histogram.edges.map((edge, i) => {
								const h = (data.histogram.cells[i] / max) * 140;
								return (
									<div key={edge} className="flex flex-1 flex-col items-center gap-1">
										<span className="text-xs text-muted-foreground">
											{data.histogram.cells[i]}
										</span>
										<div
											className="w-full rounded-t"
											style={{ height: Math.max(2, h), background: "#6366f1" }}
										/>
										<span className="text-[10px] text-muted-foreground">&le;{edge}</span>
									</div>
								);
							})}
							<div className="flex flex-1 flex-col items-center gap-1">
								<span className="text-xs text-muted-foreground">
									{data.histogram.overflow}
								</span>
								<div
									className="w-full rounded-t"
									style={{
										height: Math.max(2, (data.histogram.overflow / max) * 140),
										background: "#f87171",
									}}
								/>
								<span className="text-[10px] text-muted-foreground">&gt;250</span>
							</div>
						</div>
						<div className="mt-1 text-xs text-muted-foreground">
							Total: {data.histogram.total} · Rejects: {data.rejects.length}
						</div>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>Live Safety Envelope (VC0C)</CardTitle>
						<div className="flex items-center gap-2">
							{health?.stateSource === "ephemeral" && (
								<Badge variant="outline">EPHEMERAL (non-live)</Badge>
							)}
							<button
								onClick={onReset}
								disabled={!health?.enabled}
								className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
							>
								Reset Cooldown
							</button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{resetMsg && (
						<div className="mb-2 text-xs text-muted-foreground">{resetMsg}</div>
					)}
					{!health ? (
						<div className="vc-empty">Health unavailable (VC0C off).</div>
					) : (
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<Metric label="State" value={health.state} />
							<Metric label="Mode" value={health.mode} />
							<Metric label="Window" value={`${health.windowMs}ms`} />
							<Metric label="Probes" value={String(health.probeCount)} />
							<Metric label="Backoff" value={`${health.backoffDelayMs}ms`} />
							<Metric
								label="Failures"
								value={`${health.failures}/${health.attempts}`}
							/>
							<Metric
								label="Frontier"
								value={
									health.stateSource === "ephemeral"
										? "non-live"
										: health.frontierFrozen
											? "FROZEN"
											: "LIVE"
								}
							/>
							<Metric label="Spool lag" value={String(health.spoolLag)} />
								<Metric label="Encoder mode" value={health.encoderMode} />
								<Metric label="Encoder asset" value={health.encoderAssetDigest ? health.encoderAssetDigest.slice(0, 12) : "none"} />
						</div>
					)}
				</CardContent>
			</Card>
			<VectorCortexTopologyCard topology={topology} query={query} />
			<VectorCortexShardsCard view={shards} />
			<VectorCortexReconstructCard view={reconstruct} />
			<VectorCortexPlansCard view={plans} />
			<VectorCortexRenderCard view={render} />
			<VectorCortexRolloutCard view={rollout} />
			<VectorCortexClosureCard view={closureProof} />
			<VectorCortexRestoreCard view={restore} />
			<VectorCortexRepairCard view={repair} />
			<VectorCortexLedgerCard ledger={ledger} />
		</div>
	);
}
