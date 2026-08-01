/**
 * dashboard-client/src/components/StripeDistributionCard.tsx — Cache stripe
 * distribution visualization (A3, PLAN_V2 Phase 4).
 *
 * Renders a horizontal bar chart of stripe buckets (0–4) with stability
 * indicators, plus a health-score summary box.
 *
 * Uses only CSS-based bar rendering — no external charting dependencies.
 */

import type React from "react";
import type { CacheStripesResponse } from "@contracts";
import { fmtPctFromFraction } from "../utils/format";

const STRIPE_COLORS = [
	"ov-bar-green",   // 0 permanent
	"ov-bar-blue",    // 1 epoch
	"ov-bar-teal",    // 2 topic
	"ov-bar-yellow",  // 3 thread
	"ov-bar-gray",    // 4 volatile
];

const STRIPE_LABELS = [
	"Permanent",
	"Epoch",
	"Topic",
	"Thread",
	"Volatile",
];

const HEALTH_LABEL_COLOR: Record<string, string> = {
	good: "ov-text-green",
	fair: "ov-text-yellow",
	degraded: "ov-text-orange",
	poor: "ov-text-red",
};

export interface StripeDistributionCardProps {
	data: CacheStripesResponse;
}

export function StripeDistributionCard({
	data,
}: StripeDistributionCardProps): React.ReactElement {
	const maxCount = Math.max(...data.buckets.map((b) => b.count), 1);
	const healthColor = HEALTH_LABEL_COLOR[data.health.label] ?? "ov-text-gray";

	return (
		<div className="ov-card">
			<h3 className="ov-card-title">Cache Stripe Distribution</h3>

			{/* Health score summary */}
			<div className="ov-stripe-health-summary">
				<span className={`ov-stripe-health-badge ${healthColor}`}>
					{data.health.label}
				</span>
				<span className="ov-stripe-health-score">
					{fmtPctFromFraction(data.health.score)}
				</span>
				<span className="ov-stripe-churn">
					Churn: {fmtPctFromFraction(data.health.churnRate)}
				</span>
				<span className="ov-stripe-total">
					{data.totalChunks} total chunks
				</span>
			</div>

			{/* Bar chart — one row per stripe */}
			<div className="ov-stripe-bars">
				{data.buckets.map((bucket) => {
					const pct =
						maxCount > 0
							? Math.max(0, Math.min(100, (bucket.count / maxCount) * 100))
							: 0;
					const colorClass =
						STRIPE_COLORS[bucket.stripe] ?? "ov-bar-gray";
					const label =
						bucket.label || (STRIPE_LABELS[bucket.stripe] ?? `Stripe ${bucket.stripe}`);
					return (
						<div key={bucket.stripe} className="ov-stripe-row">
							<span className="ov-stripe-label" title={label}>
								{label}
							</span>
							<div className="ov-bar-track">
								<div
									className={`ov-bar-fill ${colorClass}`}
									style={{ width: `${pct}%` }}
								/>
							</div>
							<span className="ov-stripe-count">{bucket.count}</span>
							<span
								className="ov-stripe-stability"
								title={`min ${fmtPctFromFraction(bucket.minStability)} / max ${fmtPctFromFraction(bucket.maxStability)}`}
							>
								{fmtPctFromFraction(bucket.avgStability)}
							</span>
						</div>
					);
				})}
			</div>

			{/* Epoch info */}
			<div className="ov-stripe-footer">
				Epoch: {data.epochId ?? "—"}
				&middot;
				Dominant tier: {fmtPctFromFraction(data.health.dominantTier)}
			</div>
		</div>
	);
}
