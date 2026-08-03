/**
 * dashboard-client/src/tabs/WikiTab/TopicTimeline.tsx — per-topic timeline.
 *
 * Renders topic memory-addition buckets as a lightweight SVG bar strip (no
 * chart library needed). X = time bucket, bar height = memories added.
 * Fetches GET /api/wiki/topic/:topicId/timeline.
 *
 * Styling: Tailwind + shadcn (Card). No legacy CSS classes.
 */

import type React from "react";
import { useCallback } from "react";
import { useApi } from "../../hooks/useApi";
import { fetchTopicTimeline } from "../../api/client";
import type { TopicTimelineResponse } from "@contracts";

const W = 720;
const H = 56;
const BAR_W = 10;
const GAP = 3;

interface Props {
	topicId: string;
}

function fmtBucket(ts: number): string {
	if (!ts) return "—";
	return new Date(ts).toLocaleDateString();
}

export default function TopicTimeline({ topicId }: Props): React.ReactElement {
	const { data, error } = useApi<TopicTimelineResponse>(
		useCallback(() => fetchTopicTimeline(topicId), [topicId]),
		{},
	);

	if (error) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-4 text-sm text-muted-foreground">
				Timeline unavailable.
			</div>
		);
	}
	if (!data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-4 text-sm text-muted-foreground">
				Loading timeline…
			</div>
		);
	}

	const { buckets, total } = data;
	const max = Math.max(...buckets.map((b) => b.count), 1);
	const totalWidth = buckets.length * (BAR_W + GAP);
	const scale = Math.min(1, (W - 24) / Math.max(totalWidth, 1));

	return (
		<div className="rounded-lg border border-border bg-bg-card p-4">
			<h3 className="mb-2 font-heading text-sm font-semibold text-muted-foreground">
				Memory timeline{" "}
				<span className="font-normal text-xs">
					({total} memory{total !== 1 ? "ies" : "y"} · daily buckets)
				</span>
			</h3>
			{buckets.length === 0 ? (
				<p className="text-sm text-muted-foreground">No timeline data yet.</p>
			) : (
				<>
					<svg
						width="100%"
						height={H}
						viewBox={`0 0 ${Math.max(W, totalWidth * scale)} ${H}`}
						role="img"
						aria-label="Memory additions over time"
					>
						{buckets.map((b, i) => {
							const x = i * (BAR_W + GAP) * scale;
							const h = Math.max(3, (b.count / max) * (H - 20));
							return (
								<rect
									key={`${b.bucket}-${i}`}
									x={x}
									y={H - 6 - h}
									width={Math.max(2, BAR_W * scale)}
									height={h}
									rx={2}
									fill="hsl(var(--primary))"
									opacity={0.85}
								>
									<title>{`${fmtBucket(b.bucket)}: ${b.count}`}</title>
								</rect>
							);
						})}
					</svg>
					<p className="mt-1 text-xs text-muted-foreground">
						First display: {fmtBucket(buckets[0].bucket)} · last:
						{fmtBucket(buckets[buckets.length - 1].bucket)}
					</p>
				</>
			)}
		</div>
	);
}
