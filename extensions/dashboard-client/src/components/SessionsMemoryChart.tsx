/**
 * dashboard-client/src/components/SessionsMemoryChart.tsx — Stacked memory graph (S39).
 *
 * Recharts stacked `<Area>` per session + total `<Line>` + `<Tooltip>` +
 * `<Legend>` + `<ResponsiveContainer>`. Data comes from `/api/sessions/timeseries`
 * which returns `SessionSeries[]` (per-session data points + stable hex color)
 * and a `totals[]` array (sum across all sessions per timestamp).
 *
 * PREVENT-PI-004: recharts is bundled into this localhost-served static
 * dashboard bundle; it makes no runtime network calls. Chart data arrives via
 * same-origin fetch to the dashboard server (loopback, ports 9320–9329).
 */

import type React from "react";
import { useMemo } from "react";
import {
	ResponsiveContainer,
	AreaChart,
	Area,
	Line,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	Legend,
} from "recharts";
import type { SessionSeries } from "@contracts";
import { Card, CardContent } from "../components/ui/card";

export interface SessionsMemoryChartProps {
	/** Per-session series with stable colors (from /api/sessions/timeseries). */
	series: SessionSeries[];
	/** Totals (sum across all sessions) per timestamp. */
	totals: ReadonlyArray<{ ts: number; tokens: number }>;
}

/** A row in the pivoted data table passed to recharts `<AreaChart>`. */
interface PivotedRow {
	/** Unix timestamp (ms). */
	ts: number;
	/** Total tokens across all sessions at this timestamp. */
	total: number;
	/** Per-session token count keyed by sessionId. */
	[sessionId: string]: number;
}

/**
 * Pivot the per-session series + totals into recharts' expected flat shape:
 * one row per unique timestamp, with each session's token count as a column
 * keyed by sessionId. Missing values for a session at a given timestamp are
 * filled with zero so the stack renders continuously.
 */
function pivot(
	series: SessionSeries[],
	totals: ReadonlyArray<{ ts: number; tokens: number }>,
): PivotedRow[] {
	const map = new Map<number, PivotedRow>();
	const sessionIds = series.map((s) => s.sessionId);

	for (const s of series) {
		for (const pt of s.data) {
			let row = map.get(pt.ts);
			if (!row) {
				row = { ts: pt.ts, total: 0 } as PivotedRow;
				for (const sid of sessionIds) row[sid] = 0;
				map.set(pt.ts, row);
			}
			row[s.sessionId] = pt.tokens;
		}
	}
	for (const t of totals) {
		let row = map.get(t.ts);
		if (!row) {
			row = { ts: t.ts, total: 0 } as PivotedRow;
			for (const sid of sessionIds) row[sid] = 0;
			map.set(t.ts, row);
		}
		row.total = t.tokens;
	}

	return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function fmtTs(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function fmtTokens(value: number | string): string {
	const n = Number(value);
	return Number.isFinite(n) ? n.toLocaleString() : String(value);
}

/** Sanitize an arbitrary sessionId for use in an SVG gradient id. */
function gradId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `grad-${safe}`;
}

export function SessionsMemoryChart({
	series,
	totals,
}: SessionsMemoryChartProps): React.ReactElement {
	const data = useMemo(
		() => pivot(series, totals),
		[series, totals],
	);

	if (series.length === 0) {
		return (
			<Card>
				<CardContent>No token samples in this window yet.</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent>
			<ResponsiveContainer width="100%" height={360}>
				<AreaChart
					data={data}
					margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
				>
					<defs>
						{series.map((s) => (
							<linearGradient
								key={`${s.sessionId}-grad`}
								id={gradId(s.sessionId)}
								x1="0"
								y1="0"
								x2="0"
								y2="1"
							>
								<stop offset="5%" stopColor={s.color} stopOpacity={0.7} />
								<stop offset="95%" stopColor={s.color} stopOpacity={0.25} />
							</linearGradient>
						))}
					</defs>
					<CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
					<XAxis
						dataKey="ts"
						type="number"
						domain={["dataMin", "dataMax"]}
						tickFormatter={(ts: number) => fmtTs(ts)}
						stroke="#8b949e"
						tick={{ fontSize: 11 }}
						scale="time"
					/>
					<YAxis
						stroke="#8b949e"
						tick={{ fontSize: 11 }}
						width={56}
						tickFormatter={(v: number) => fmtTokens(v)}
					/>
					<Tooltip
						labelFormatter={(ts: number) => fmtTs(ts)}
						formatter={(value) =>
							[fmtTokens(value as number), "tokens"] as [string, string]
						}
						contentStyle={{
							background: "#161b22",
							border: "1px solid #30363d",
							borderRadius: "6px",
							color: "#e6edf3",
						}}
						labelStyle={{ color: "#8b949e", fontSize: 12 }}
					/>
					<Legend wrapperStyle={{ fontSize: 12 }} />
					{series.map((s) => (
						<Area
							key={s.sessionId}
							type="monotone"
							dataKey={s.sessionId}
							name={s.label}
							stackId="1"
							stroke={s.color}
							fill={`url(#${gradId(s.sessionId)})`}
							fillOpacity={1}
							isAnimationActive={false}
							dot={false}
						/>
					))}
					<Line
						type="monotone"
						dataKey="total"
						name="Total"
						stroke="#e6edf3"
						strokeWidth={1.5}
						strokeDasharray="4 2"
						dot={false}
						isAnimationActive={false}
					/>
				</AreaChart>
			</ResponsiveContainer>
			</CardContent>
		</Card>
	);
}
