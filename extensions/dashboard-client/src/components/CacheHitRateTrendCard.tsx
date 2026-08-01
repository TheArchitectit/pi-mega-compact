/**
 * dashboard-client/src/components/CacheHitRateTrendCard.tsx -- Cache hit-rate
 * time-series trend chart (A3, PLAN_V2 Phase 4).
 *
 * Renders a sparkline view of cache hit rate from the /api/perf endpoint using
 * real cache_hit_pct samples with timestamps. Each bar represents one sample.
 * Shows the latest, average, and sample count.
 *
 * Uses .ov-sparkline / .ov-sparkline-bar CSS classes from cache.css.
 * No external charting dependencies.
 */

import type React from "react";
import type { PerfResponse, CacheHitSample } from "@contracts";

export interface CacheHitRateTrendCardProps {
	perf: PerfResponse;
}

function fmtPct(n: number): string {
	return `${n.toFixed(1)}%`;
}

/**
 * Map a percentage (0–100) to a CSS color class:
 *   >= 80: green   (healthy)
 *   >= 60: teal    (fair)
 *   >= 40: yellow  (degraded)
 *   >= 20: orange  (poor)
 *   <  20: red     (critical)
 */
function pctColorClass(pct: number): string {
	if (pct >= 80) return "ov-bar-green";
	if (pct >= 60) return "ov-bar-teal";
	if (pct >= 40) return "ov-bar-yellow";
	if (pct >= 20) return "ov-bar-orange";
	return "ov-bar-red";
}

export const CacheHitRateTrendCard: React.FC<CacheHitRateTrendCardProps> = ({
	perf,
}) => {
	const { cache_hit_pct: c } = perf;
	const samples: CacheHitSample[] =
		c.samples && c.samples.length > 0 ? c.samples : [];

	return (
		<div className="ov-card cache-trend-card">
			<h3 className="ov-card-title">Cache Hit-Rate Trend</h3>

			{/* Metric summary */}
			<div className="ov-perf-summary">
				<div className="ov-perf-stat">
					Avg: <strong>{fmtPct(c.avg)}</strong>
				</div>
				<div className="ov-perf-stat">
					Latest: <strong>{fmtPct(c.latest)}</strong>
				</div>
				<div className="ov-perf-stat">
					Samples: <strong>{c.n}</strong>
				</div>
			</div>

			{/* Sparkline bars from real samples */}
			{samples.length > 0 ? (
				<>
					<div
						className="ov-sparkline"
						role="img"
						aria-label={`Cache hit rate trend: ${c.n} samples, average ${fmtPct(c.avg)}, latest ${fmtPct(c.latest)}`}
					>
						{samples.map((s, i) => {
							const barH = Math.max(2, Math.round(s.pct * 0.6));
							const colorClass = pctColorClass(s.pct);
							const isLatest = i === samples.length - 1;
							return (
								<div
									key={i}
									className={`ov-sparkline-bar ${colorClass}${isLatest ? " ov-bar-latest" : ""}`}
									style={{ height: `${barH}px` }}
									title={`${fmtPct(s.pct)} at ${new Date(s.ts).toLocaleTimeString()}`}
								/>
							);
						})}
					</div>
					<div className="ov-card-footer">
						{samples.length} sample{samples.length !== 1 ? "s" : ""} over{" "}
						{samples.length > 1
							? `${Math.round(
									(samples[samples.length - 1].ts - samples[0].ts) / 1000,
								)}s`
							: "latest turn"}
					</div>
				</>
			) : (
				<div className="ov-empty-state">No cache-hit samples yet</div>
			)}
		</div>
	);
};
