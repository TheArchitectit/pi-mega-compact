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
	fetchVectorCortexShards,
	fetchVectorCortexTopology,
	resetVectorCortexBreaker,
	type VectorCortexEvaluationSummary,
	type VectorCortexHealthCard,
	type VectorCortexLedgerView,
	type VectorCortexQueryView,
	type VectorCortexShardsView,
	type VectorCortexTopologyView,
} from "../api/vector-cortex";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

function ModeChip({ mode, count }: { mode: string; count: number }): React.ReactElement {
	return (
		<div className="flex items-center justify-between border-b border-border/50 py-1 text-sm">
			<span className="text-muted-foreground">Mode {mode}</span>
			<span className="font-mono">{count}</span>
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
	return (
		<div>
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="font-mono text-sm">{value}</div>
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
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>Derived Cortex Store (VC3A)</CardTitle>
						{topology?.enabled ? (
							<Badge variant="success">ACTIVE</Badge>
						) : (
							<Badge variant="danger">OFF</Badge>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{!topology?.enabled ? (
						<div className="vc-empty">Cortex store disabled (VC3A off).</div>
					) : (
						<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-3">
							<Metric label="Generation" value={topology.generationId ?? "—"} />
							<Metric label="Ordinal" value={topology.ordinal ?? "—"} />
							<Metric label="Records" value={String(topology.recordCount)} />
							<Metric label="Frontier (HW)" value={topology.sourceHighWater} />
							<Metric
								label="Root digest"
								value={topology.rootDigest ? topology.rootDigest.slice(0, 16) : "—"}
							/>
							{topology.nodes !== undefined && (
								<>
									<Metric
										label="Nodes"
										value={String(topology.nodes?.length ?? 0)}
									/>
									<Metric
										label="Edges"
										value={String(topology.edges?.length ?? 0)}
									/>
									<Metric
										label="Graph digest"
										value={
											topology.generationDigest
												? topology.generationDigest.slice(0, 16)
												: "—"
										}
									/>
								</>
							)}
						</div>
						{topology.nodes !== undefined &&
							(topology.edges?.length ?? 0) > 0 && (
								<div className="mt-4 max-h-56 overflow-y-auto">
									<div className="mb-1 text-xs font-medium text-muted-foreground">
										Topology edges (VC3B)
									</div>
									<table className="w-full text-left text-xs">
										<thead>
											<tr className="border-b border-border/50 text-muted-foreground">
												<th className="py-1 pr-2">source</th>
												<th className="py-1 pr-2">target</th>
												<th className="py-1 pr-2">head</th>
												<th className="py-1 pr-2">dir</th>
												<th className="py-1">score</th>
											</tr>
										</thead>
										<tbody>
											{topology.edges?.map((e, i) => (
												<tr
													key={`${e.source}-${e.target}-${e.head}-${i}`}
													className="border-b border-border/30"
												>
													<td className="py-1 pr-2 font-mono">{e.source}</td>
													<td className="py-1 pr-2 font-mono">{e.target}</td>
													<td className="py-1 pr-2 font-mono">{e.head}</td>
													<td className="py-1 pr-2">{e.direction}</td>
													<td className="py-1 font-mono">{e.score}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>Topology Query Diagnostics (VC3C)</CardTitle>
						{query?.enabled ? (
							<Badge variant="success">ACTIVE</Badge>
						) : (
							<Badge variant="danger">OFF</Badge>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{!query?.enabled ? (
						<div className="vc-empty">Query diagnostics unavailable (VC3C off).</div>
					) : (
						<div className="grid grid-cols-2 gap-4 md:grid-cols-3">
							<Metric label="Router version" value={String(query.routerVersion)} />
						</div>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>Dual-Tier Shards (VC4A)</CardTitle>
						{shards?.enabled ? (
							<Badge variant="success">ACTIVE</Badge>
						) : (
							<Badge variant="danger">OFF</Badge>
						)}
				</div>
				</CardHeader>
				<CardContent>
					{!shards?.enabled ? (
						<div className="vc-empty">Dual-tier shards disabled (VC4A off).</div>
					) : (
						<>
							<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
								<Metric label="Semantic shards" value={String(shards.semanticCount)} />
								<Metric label="Exact shards" value={String(shards.exactCount)} />
								<Metric label="Byte total" value={String(shards.byteTotal)} />
								<Metric label="Protected bytes" value={String(shards.protectedByteTotal)} />
							</div>
							<div className="mt-3 text-xs text-muted-foreground">
								Reader-only count/byte aggregate; staged in-memory this sprint.
							</div>
						</>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>Occurrence Ledger (VC1B)</CardTitle>
						{ledger?.enabled ? (
							<Badge variant="success">ACTIVE</Badge>
						) : (
							<Badge variant="danger">OFF</Badge>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{!ledger?.enabled ? (
						<div className="vc-empty">Ledger disabled (VC1B off).</div>
					) : (
						<>
							<div className="mb-3 grid grid-cols-2 gap-4 md:grid-cols-3">
								<Metric label="Session" value={ledger.session} />
								<Metric label="High-water" value={ledger.highWater} />
								<Metric label="Occurrences" value={String(ledger.count)} />
							</div>
							{ledger.occurrences.length === 0 ? (
								<div className="vc-empty">No occurrences recorded.</div>
							) : (
								<div className="max-h-64 overflow-y-auto">
									<table className="w-full text-left text-xs">
										<thead>
											<tr className="border-b border-border/50 text-muted-foreground">
												<th className="py-1 pr-2">seq</th>
												<th className="py-1 pr-2">eventId</th>
												<th className="py-1 pr-2">kind</th>
												<th className="py-1 pr-2">toolCall</th>
												<th className="py-1">digest</th>
											</tr>
										</thead>
										<tbody>
											{ledger.occurrences.map((o) => (
												<tr
													key={`${o.seq}-${o.eventId}`}
													className="border-b border-border/30"
												>
													<td className="py-1 pr-2 font-mono">{o.seq}</td>
													<td className="py-1 pr-2 font-mono">{o.eventId}</td>
													<td className="py-1 pr-2">{o.kind}</td>
													<td className="py-1 pr-2 font-mono">
														{o.toolCallId ?? "\u2014"}
													</td>
													<td className="max-w-[180px] truncate font-mono text-muted-foreground">
														{o.digest}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
