/**
 * dashboard-client/src/components/charts/PerfBarChart.tsx — reusable perf bar chart.
 *
 * Recharts BarChart with the dashboard dark theme (AXIS "#8b949e",
 * GRID "#30363d", dark tooltip). Renders `{label, value}` buckets.
 * Handles empty data with a "No data available" message.
 *
 * PREVENT-PI-004: recharts is bundled into this localhost-served static
 * dashboard bundle; it makes no runtime network calls.
 */

import type React from "react";
import {
	ResponsiveContainer,
	BarChart,
	Bar,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
} from "recharts";

export interface PerfBarChartProps {
	/** Buckets with a display label + numeric value. */
	data: Array<{ label: string; value: number }>;
	/** Bar color (default dashboard green). */
	color?: string;
	/** Chart height in px (default 280). */
	height?: number;
	/** Optional formatter for values (e.g. "$" prefix, thousands separators). */
	valueFormatter?: (v: number) => string;
}

const AXIS_COLOR = "#8b949e";
const GRID_COLOR = "#30363d";
const TOOLTIP_STYLE = {
	background: "#161b22",
	border: "1px solid #30363d",
	borderRadius: "6px",
	color: "#e6edf3",
};

export function PerfBarChart({
	data,
	color = "#3fb950",
	height = 280,
	valueFormatter,
}: PerfBarChartProps): React.ReactElement {
	const fmt = valueFormatter ?? ((v: number) => String(v));

	if (!data || data.length === 0) {
		return <p className="py-8 text-center text-sm text-muted-foreground">No data available</p>;
	}

	return (
		<ResponsiveContainer width="100%" height={height}>
			<BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
				<CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
				<XAxis
					dataKey="label"
					stroke={AXIS_COLOR}
					tick={{ fontSize: 11 }}
					interval={0}
					angle={-20}
					textAnchor="end"
					height={56}
				/>
				<YAxis
					dataKey="value"
					stroke={AXIS_COLOR}
					tick={{ fontSize: 11 }}
					width={56}
					tickFormatter={(v: number) => fmt(v)}
				/>
				<Tooltip
					formatter={(value) => [fmt(value as number), "value"] as [string, string]}
					contentStyle={TOOLTIP_STYLE}
					labelStyle={{ color: AXIS_COLOR, fontSize: 12 }}
				/>
				<Bar
					dataKey="value"
					fill={color}
					radius={[4, 4, 0, 0]}
					isAnimationActive={false}
				/>
			</BarChart>
		</ResponsiveContainer>
	);
}
