/**
 * dashboard-client/src/components/charts/PerfLineChart.tsx — reusable perf line chart.
 *
 * Recharts LineChart with the dashboard dark theme (AXIS "#8b949e",
 * GRID "#30363d", dark tooltip). Renders `{ts, value}` samples over time.
 * Handles empty data with a "No data available" message.
 *
 * PREVENT-PI-004: recharts is bundled into this localhost-served static
 * dashboard bundle; it makes no runtime network calls.
 */

import type React from "react";
import {
	ResponsiveContainer,
	LineChart,
	Line,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
} from "recharts";

export interface PerfLineChartProps {
	/** Time-series samples ascending by ts (epoch ms). */
	data: Array<{ ts: number; value: number }>;
	/** Optional series label shown in the tooltip. */
	label?: string;
	/** Line + gradient color (default dashboard blue). */
	color?: string;
	/** Chart height in px (default 280). */
	height?: number;
}

const AXIS_COLOR = "#8b949e";
const GRID_COLOR = "#30363d";
const TOOLTIP_STYLE = {
	background: "#161b22",
	border: "1px solid #30363d",
	borderRadius: "6px",
	color: "#e6edf3",
};

function fmtTs(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

function fmtVal(v: number): string {
	return Number.isFinite(v) ? String(v) : String(v);
}

export function PerfLineChart({
	data,
	label = "value",
	color = "#58a6ff",
	height = 280,
}: PerfLineChartProps): React.ReactElement {
	if (!data || data.length === 0) {
		return <p className="py-8 text-center text-sm text-muted-foreground">No data available</p>;
	}

	const gradId = `perf-line-${color.replace(/[^a-zA-Z0-9]/g, "")}`;

	return (
		<ResponsiveContainer width="100%" height={height}>
			<LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
				<defs>
					<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="5%" stopColor={color} stopOpacity={0.7} />
						<stop offset="95%" stopColor={color} stopOpacity={0.15} />
					</linearGradient>
				</defs>
				<CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
				<XAxis
					dataKey="ts"
					type="number"
					domain={["dataMin", "dataMax"]}
					scale="time"
					tickFormatter={(ts: number) => fmtTs(ts)}
					stroke={AXIS_COLOR}
					tick={{ fontSize: 11 }}
				/>
				<YAxis
					dataKey="value"
					stroke={AXIS_COLOR}
					tick={{ fontSize: 11 }}
					width={56}
					tickFormatter={(v: number) => fmtVal(v)}
				/>
				<Tooltip
					labelFormatter={(ts: number) => fmtTs(ts)}
					formatter={(value) => [fmtVal(value as number), label] as [string, string]}
					contentStyle={TOOLTIP_STYLE}
					labelStyle={{ color: AXIS_COLOR, fontSize: 12 }}
				/>
				<Line
					type="monotone"
					dataKey="value"
					name={label}
					stroke={color}
					strokeWidth={2}
					dot={false}
					fill={`url(#${gradId})`}
					isAnimationActive={false}
				/>
			</LineChart>
		</ResponsiveContainer>
	);
}
