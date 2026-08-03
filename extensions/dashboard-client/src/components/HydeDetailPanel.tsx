/**
 * dashboard-client/src/components/HydeDetailPanel.tsx — per-turn HyDE + recall
 * quality detail (H3.1).
 *
 * Fetches /api/rag-metrics once and indexes telemetry rows by the composite
 * `conversationId:turnIndex` key (the dashboard TurnRow has no DB id, so the
 * pair is the stable identifier). Renders one of three HyDE states:
 *   - HyDE ran: hypothetical doc (collapsible), raw/hyde/fused hit counts,
 *     lift multiplier, generation latency.
 *   - HyDE skipped: reason (disabled / no-llm / generation-failed).
 *   - No telemetry: nothing (the parent only renders us when flagged).
 * Plus a CRAG-style mini score line when recall metrics exist.
 *
 * PREVENT-PI-004: relative-path fetch to the same-origin dashboard server.
 */

import type React from "react";
import { useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { fetchRagMetrics } from "../api/client";
import type { RagMetricsResponse } from "@contracts";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";

/** Per-turn telemetry row shape derived from the rag-metrics contract. */
type TelemetryRow = RagMetricsResponse["recent"][number];

export interface HydeDetailPanelProps {
	conversationId: string;
	turnIndex: number;
}

/** Composite key matching a telemetry row to a rendered turn. */
function rowKey(conversationId: string, turnIndex: number): string {
	return `${conversationId}:${turnIndex}`;
}

/** First N lines of the hypothetical doc (or full when expanded). */
function truncateDoc(doc: string, maxLines: number): string {
	const lines = doc.split("\n");
	return lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : doc;
}

/** CRAG-style mini score line when recall metrics were captured. */
function ScoreLine({ row }: { row: TelemetryRow }): React.ReactElement {
	const hasScore = row.recallScore > 0 || row.recallPass === 1;
	if (!hasScore) {
		return (
			<div className="mt-2 text-xs text-muted-foreground">
				No recall-quality metrics for this turn.
			</div>
		);
	}
	return (
		<div className="mt-2 rounded-md border border-border/60 bg-bg-elevated/40 p-2">
			<div className="flex items-center gap-2 text-xs">
				<span className="font-medium text-muted-foreground">Recall quality</span>
				<Badge variant={row.recallPass === 1 ? "success" : "warning"}>
					{row.recallPass === 1 ? "pass" : "fail"}
				</Badge>
				<span>
					score <strong className="text-foreground">{row.recallScore.toFixed(2)}</strong>
				</span>
			</div>
			<div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
				<span>relevance {row.recallRelevance.toFixed(2)}</span>
				<span>coverage {row.recallCoverage.toFixed(2)}</span>
				<span>diversity {row.recallDiversity.toFixed(2)}</span>
				<span>specificity {row.recallSpecificity.toFixed(2)}</span>
			</div>
		</div>
	);
}

export const HydeDetailPanel: React.FC<HydeDetailPanelProps> = ({
	conversationId,
	turnIndex,
}) => {
	const { data: metrics } = useApi<RagMetricsResponse>(
		useMemo(() => () => fetchRagMetrics(), []),
		{ pollInterval: 30_000 },
	);
	const [showFullDoc, setShowFullDoc] = useState(false);

	// Rebuild the index whenever metrics arrive; rare enough that a full
	// rebuild on each render is cheaper than memoizing with a mutable dep.
	const row = useMemo(
		() =>
			metrics?.recent.find(
				(t) => rowKey(t.conversationId, t.turnIndex) === rowKey(conversationId, turnIndex),
			) ?? null,
		[metrics, conversationId, turnIndex],
	);

	if (!metrics) {
		return <div className="text-xs text-muted-foreground">Loading HyDE stats…</div>;
	}
	if (!row) {
		return (
			<div className="text-xs text-muted-foreground">
				No HyDE/recall telemetry recorded for this turn.
			</div>
		);
	}

	const doc = row.hydeDoc ?? "";
	const docLines = doc.split("\n").length;
	const showDoc = docLines > 3;
	const visibleDoc = showFullDoc || !showDoc ? doc : truncateDoc(doc, 3);

	return (
		<Card className="border border-border/60 bg-bg-elevated/20 p-3">
			{row.hydeRan === 1 ? (
				<>
					<div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
						<Badge variant="accent">HyDE ran</Badge>
						<span className="text-muted-foreground">
							gen <strong className="text-foreground">{row.hydeGenerationMs}ms</strong>
						</span>
						<span className="text-muted-foreground">
							raw <strong className="text-foreground">{row.hydeRawCount}</strong>
							<Arrow />
							hyde <strong className="text-foreground">{row.hydeHydeCount}</strong>
							<Arrow />
							fused <strong className="text-foreground">{row.hydeFusedCount}</strong>
						</span>
						<span className="text-muted-foreground">
							lift{" "}
							<strong className="text-neon">{row.hydeLift.toFixed(2)}×</strong>
						</span>
					</div>
					{doc && (
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-bg-elevated/40 p-2 font-mono text-xs text-muted-foreground">
							{visibleDoc}
						</pre>
					)}
					{showDoc && (
						<button
							type="button"
							className="mt-1 text-xs text-accent underline"
							onClick={() => setShowFullDoc((v) => !v)}
						>
							{showFullDoc ? "Show less" : "Show full hypothetical doc"}
						</button>
					)}
				</>
			) : (
				<div className="flex items-center gap-2 text-xs">
					<Badge variant="warning">HyDE skipped</Badge>
					<span className="text-muted-foreground">{skipReason(row)}</span>
				</div>
			)}
			<ScoreLine row={row} />
		</Card>
	);
};

function Arrow(): React.ReactElement {
	return <span className="text-muted-foreground/60"> → </span>;
}

function skipReason(row: TelemetryRow): string {
	switch (row.hydeReason) {
		case "no-llm":
			return "No LLM embedder available (requires Ollama/HTTP embedder).";
		case "generation-failed":
			return "Hypothetical doc generation failed this turn.";
		case "disabled":
			return "HyDE is disabled (MEGACOMPACT_HYDE_DISABLED).";
		default:
			return "HyDE was not invoked for this turn.";
	}
}
