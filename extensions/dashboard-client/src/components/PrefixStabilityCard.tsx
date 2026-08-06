/**
 * dashboard-client/src/components/PrefixStabilityCard.tsx -- Prompt-cache per-turn
 * stable-prefix ratio trend (PC-C).
 *
 * Renders a sparkline of the per-turn stable-prefix ratio (stablePrefix /
 * totalMessages) read from /api/prefix-stability, with the average ratio and a
 * three-point trend badge ("improving" | "stable" | "degrading"). Each bar is one
 * turn. Uses the same .ov-sparkline / .ov-bar-* CSS classes as CacheHitRateTrendCard.
 * No external charting dependencies.
 */

import type React from "react";
import type { PrefixStabilityResponse } from "@contracts";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export interface PrefixStabilityCardProps {
	data: PrefixStabilityResponse;
}

function fmtRatio(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

/** Map a ratio (0–1) to a CSS color class (mirrors pctColorClass thresholds). */
function ratioColorClass(ratio: number): string {
	const pct = ratio * 100;
	if (pct >= 80) return "ov-bar-green";
	if (pct >= 60) return "ov-bar-teal";
	if (pct >= 40) return "ov-bar-yellow";
	if (pct >= 20) return "ov-bar-orange";
	return "ov-bar-red";
}

const TREND_LABEL: Record<PrefixStabilityResponse["trend"], string> = {
	improving: "Improving",
	stable: "Stable",
	degrading: "Degrading",
};

export const PrefixStabilityCard: React.FC<PrefixStabilityCardProps> = ({
	data,
}) => {
	const { turns, avgRatio, trend } = data;

	return (
		<Card className="electric-hover">
			<CardHeader>
				<CardTitle>Per-Turn Stable Prefix</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="mb-3 flex gap-4 text-sm text-muted-foreground">
					<div>
						Avg:{" "}
						<strong className="text-foreground">{fmtRatio(avgRatio)}</strong>
					</div>
					<div>
						Trend:{" "}
						<strong className="text-foreground">{TREND_LABEL[trend]}</strong>
					</div>
					<div>
						Turns: <strong className="text-foreground">{turns.length}</strong>
					</div>
				</div>

				{turns.length > 0 ? (
					<>
						<div
							className="ov-sparkline"
							role="img"
							aria-label={`Per-turn stable-prefix ratio trend: ${turns.length} turns, average ${fmtRatio(avgRatio)}, trend ${TREND_LABEL[trend]}`}
						>
							{turns.map((t, i) => {
								const barH = Math.max(2, Math.round(t.ratio * 60));
								const colorClass = ratioColorClass(t.ratio);
								const isLatest = i === turns.length - 1;
								return (
									<div
										key={i}
										className={`ov-sparkline-bar ${colorClass}${isLatest ? " ov-bar-latest" : ""}`}
										style={{ height: `${barH}px` }}
										title={`Turn ${t.turnIndex}: ${fmtRatio(t.ratio)} (${t.stablePrefix}/${t.totalMessages} msg) @ ${new Date(t.timestamp).toLocaleTimeString()}`}
									/>
								);
							})}
						</div>
						<div className="mt-1 text-xs text-muted-foreground">
							Shared prompt-cache prefix ratio per turn — higher is better.
						</div>
					</>
				) : (
					<div className="text-sm text-muted-foreground">
						No stable-prefix samples yet
					</div>
				)}
			</CardContent>
		</Card>
	);
};
