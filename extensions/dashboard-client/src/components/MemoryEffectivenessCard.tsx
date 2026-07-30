/**
 * dashboard-client/src/components/MemoryEffectivenessCard.tsx — Memory
 * Effectiveness card (S53B).
 *
 * First dashboard surface for the durable-memory RAG: how many memories are
 * stored, how many recall actually served in the last 30 days (from the
 * memory-source turn_recall provenance recorded from S53B onward), average
 * recall score, and the top-stable memories (the candidates that survive
 * prompt-cache striping in S54/S55).
 */

import type React from "react";
import type { MemoryStatusResponse } from "@contracts";

export interface MemoryEffectivenessCardProps {
	status: MemoryStatusResponse;
}

function StatRow({
	label,
	value,
	title,
}: {
	label: string;
	value: string;
	title?: string;
}): React.ReactElement {
	return (
		<div className="ov-stat-row">
			<span className="ov-stat-label" title={title}>
				{label}
			</span>
			<span className="ov-stat-value">{value}</span>
		</div>
	);
}

export function MemoryEffectivenessCard(
	props: MemoryEffectivenessCardProps,
): React.ReactElement {
	const { status: s } = props;
	const empty = s.totals.memories === 0;
	return (
		<div className="card memory-effectiveness-card">
			<h3>🧠 Memory Effectiveness</h3>
			{empty ? (
				<div className="ov-stat-row">
					<span className="ov-stat-label">
						No durable memories stored yet. Memories accumulate as turns are
						reviewed (auto-review cadence is pressure-scaled, S24).
					</span>
				</div>
			) : (
				<>
					<StatRow
						label="Memories Stored"
						value={s.totals.memories.toLocaleString()}
						title="Durable memories in the store (LRU-capped per repo)."
					/>
					<StatRow
						label="Never Served"
						value={s.totals.neverReferenced.toLocaleString()}
						title="Memories recall has never selected — dead weight candidates."
					/>
					<StatRow
						label="Recall Events (30d)"
						value={s.recall.events30d.toLocaleString()}
						title="Memory-source injections recorded into turn_recall in the last 30 days (tracking begins with S53B)."
					/>
					<StatRow
						label="Distinct Recalled (30d)"
						value={s.recall.distinctMemories30d.toLocaleString()}
						title="Distinct memories served in the window."
					/>
					<StatRow
						label="Avg Recall Score"
						value={
							s.recall.avgScore != null
								? `${(s.recall.avgScore * 100).toFixed(1)}%`
								: "—"
						}
						title="Mean cosine/relevance score of the served memories."
					/>
					<StatRow
						label="Stable (≥0.6)"
						value={
							s.totals.stable != null ? s.totals.stable.toLocaleString() : "—"
						}
						title="Memory stability blend ≥ 0.6 (0.5×30d frequency + 0.3×recency + 0.2×avg score). '—' when MEGACOMPACT_MEMORY_STABILITY is off."
					/>
					{s.topStable.length > 0 && (
						<div className="ov-subtable">
							{s.topStable.slice(0, 5).map((m) => (
								<div className="ov-stat-row" key={m.id}>
									<span className="ov-stat-label">
										#{m.id} {m.kind}
										{m.category ? ` · ${m.category}` : ""}
									</span>
									<span className="ov-stat-value">
										  {(m.stability * 100).toFixed(0)}% stable · {m.events30d}×
									</span>
								</div>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
