/**
 * dashboard-client/src/components/RagDashboard.tsx — full RAG metrics section
 * (H3.2). Rendered in the Metrics tab.
 *
 * Fetches /api/rag-metrics and renders:
 *   1. Stat row: telemetry turns, HyDE-ran count, avg lift, pass rate.
 *   2. HyDE Recall Lift Bar (BarChart over daily avg lift).
 *   3. CRAG Quality Line (LineChart over daily avg score).
 *   4. Per-flag status dots (hydeEnabled, recallMetricsEnabled).
 *   5. Recall Latency Stacked Bar (hyde vs base turn counts) + Hit-Rate Area.
 *
 * PREVENT-PI-004: relative-path fetch to the same-origin dashboard server.
 * recharts is bundled into this localhost-served static bundle (no runtime
 * network calls).
 */

import type React from "react";
import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { fetchRagMetrics } from "../api/client";
import type { RagMetricsResponse } from "@contracts";

/** Daily-aggregate row shape (derived from the rag-metrics contract). */
type DailyTelemetry = RagMetricsResponse["daily"][number];
import {
	ResponsiveContainer,
	BarChart,
	Bar,
	LineChart,
	Line,
	AreaChart,
	Area,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	Legend,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";

const AXIS = "#8b949e";
const GRID = "#30363d";
const TOOLTIP = {
	background: "#161b22",
	border: "1px solid #30363d",
	borderRadius: "6px",
	color: "#e6edf3",
	fontSize: 12,
} as const;

/** One row per day, with lead/lag-safe derived series for the charts. */
interface DailyRow {
	day: string;
	avgLift: number;
	avgScore: number;
	avgGenMs: number;
	passRate: number;
	hydeTurns: number;
	baseTurns: number;
	recallCount: number;
}

function toRows(daily: DailyTelemetry[]): DailyRow[] {
	return daily.map((d) => {
		const baseTurns = Math.max(0, d.recallCount - d.hydeRanCount);
		return {
			day: d.day.slice(5), // "MM-DD"
			avgLift: d.avgLift ?? 0,
			avgScore: d.avgScore ?? 0,
			avgGenMs: d.avgGenMs ?? 0,
			passRate: d.avgScore == null ? 0 : d.avgScore,
			hydeTurns: d.hydeRanCount,
			baseTurns,
			recallCount: d.recallCount,
		};
	});
}

export interface RagDashboardProps {
	/** Optional pre-fetched metrics; when absent, the card fetches inline. */
	metrics?: RagMetricsResponse | null;
}

export const RagDashboard: React.FC<RagDashboardProps> = ({ metrics }) => {
	const { data, loading } = useApi<RagMetricsResponse>(
		useMemo(() => () => fetchRagMetrics(), []),
		{ pollInterval: 30_000 },
	);
	const m = metrics ?? data;
	const rows = useMemo(() => (m ? toRows(m.daily) : []), [m]);

	if (loading && !m) {
		return <div className="text-sm text-muted-foreground">Loading RAG metrics…</div>;
	}
	if (!m) {
		return (
			<div className="text-sm text-muted-foreground">
				No RAG metrics available yet. They appear once turns record HyDE/recall
				telemetry.
			</div>
		);
	}

	const { totals, flags } = m;

	return (
		<div className="flex flex-col gap-4">
			<StatRow totals={totals} flags={flags} />

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>HyDE Recall Lift</CardTitle>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={200}>
							<BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
								<CartesianGrid strokeDasharray="3 3" stroke={GRID} />
								<XAxis dataKey="day" stroke={AXIS} tick={{ fontSize: 11 }} />
								<YAxis stroke={AXIS} tick={{ fontSize: 11 }} width={40} />
								<Tooltip contentStyle={TOOLTIP} />
								<Bar dataKey="avgLift" name="avg lift" fill="#58a6ff" isAnimationActive={false} />
							</BarChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>CRAG Quality</CardTitle>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={200}>
							<LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
								<CartesianGrid strokeDasharray="3 3" stroke={GRID} />
								<XAxis dataKey="day" stroke={AXIS} tick={{ fontSize: 11 }} />
								<YAxis stroke={AXIS} tick={{ fontSize: 11 }} width={40} domain={[0, 1]} />
								<Tooltip contentStyle={TOOLTIP} />
								<Line type="monotone" dataKey="avgScore" name="avg score" stroke="#3fb950" dot={false} strokeWidth={2} isAnimationActive={false} />
							</LineChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Recall Latency (avg gen ms)</CardTitle>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={200}>
							<BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
								<CartesianGrid strokeDasharray="3 3" stroke={GRID} />
								<XAxis dataKey="day" stroke={AXIS} tick={{ fontSize: 11 }} />
								<YAxis stroke={AXIS} tick={{ fontSize: 11 }} width={40} />
								<Tooltip contentStyle={TOOLTIP} />
								<Bar dataKey="avgGenMs" name="gen ms" fill="#d29922" isAnimationActive={false} />
							</BarChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>HyDE vs Base Turn Volume</CardTitle>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={200}>
							<AreaChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
								<CartesianGrid strokeDasharray="3 3" stroke={GRID} />
								<XAxis dataKey="day" stroke={AXIS} tick={{ fontSize: 11 }} />
								<YAxis stroke={AXIS} tick={{ fontSize: 11 }} width={40} />
								<Tooltip contentStyle={TOOLTIP} />
								<Legend wrapperStyle={{ fontSize: 11 }} />
								<Area type="monotone" dataKey="hydeTurns" name="hyde turns" stackId="1" stroke="#58a6ff" fill="#58a6ff" fillOpacity={0.5} isAnimationActive={false} />
								<Area type="monotone" dataKey="baseTurns" name="base turns" stackId="1" stroke="#8b949e" fill="#8b949e" fillOpacity={0.4} isAnimationActive={false} />
							</AreaChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>
			</div>
		</div>
	);
};

function StatRow({
	totals,
	flags,
}: {
	totals: RagMetricsResponse["totals"];
	flags: RagMetricsResponse["flags"];
}): React.ReactElement {
	const stats: Array<{ label: string; value: string; hint: string }> = [
		{
			label: "Telemetry turns",
			value: String(totals.telemetryTurns),
			hint: "turns with HyDE or recall data",
		},
		{
			label: "HyDE ran",
			value: String(totals.hydeRanTurns),
			hint: "turns where HyDE generated a doc",
		},
		{
			label: "Avg lift",
			value: `${totals.avgLift.toFixed(2)}×`,
			hint: "fused / raw hit breadth",
		},
		{
			label: "Pass rate",
			value: `${Math.round(totals.recentPassRate * 100)}%`,
			hint: totals.avgScore == null ? "no scored turns" : `avg score ${totals.avgScore.toFixed(2)}`,
		},
	];

	return (
		<div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
			{stats.map((s) => (
				<Card key={s.label}>
					<CardContent>
						<div className="text-xs text-muted-foreground">{s.label}</div>
						<div className="font-heading text-2xl font-semibold text-foreground">
							{s.value}
						</div>
						<div className="mt-0.5 text-xs text-muted-foreground">{s.hint}</div>
					</CardContent>
				</Card>
			))}
			<Card>
				<CardContent>
					<div className="text-xs text-muted-foreground">Flags</div>
					<div className="mt-1 flex flex-col gap-1 text-xs">
						<FlagDot label="HyDE" on={flags.hydeEnabled} />
						<FlagDot label="Recall metrics" on={flags.recallMetricsEnabled} />
					</div>
				</CardContent>
			</Card>
		</div>
	);
}

function FlagDot({ label, on }: { label: string; on: boolean }): React.ReactElement {
	return (
		<span className="flex items-center gap-1.5">
			<span
				className={`inline-block h-2 w-2 rounded-full ${on ? "bg-success" : "bg-danger"}`}
				aria-hidden="true"
			/>
			{label}:{" "}
			<Badge variant={on ? "success" : "danger"}>{on ? "on" : "off"}</Badge>
		</span>
	);
}
