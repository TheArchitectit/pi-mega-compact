/**
 * dashboard-client/src/tabs/TopicsTab.tsx — Auto-categorizing wiki (S51 + S52 polish).
 *
 * Fetches /api/topics and renders the k-means + TF-IDF topic clusters. S52 polish
 * adds: (1) a search box filtering topics by label / discriminative term, and
 * (2) a topic drill-down — click a topic to load its member memories
 * (/api/topics/:id/memories). Read-only; no write operations.
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { fetchTopics, fetchTopicMemories } from "../api/client";
import type { TopicsResponse, TopicMemoriesResponse } from "@contracts";

function fmtTs(ms: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}

export default function TopicsTab(): React.ReactElement {
	const { data, loading, error } = useApi<TopicsResponse>(
		useCallback(() => fetchTopics(), []),
		{ pollInterval: 30_000 },
	);
	const [query, setQuery] = useState("");
	const [drillTopicId, setDrillTopicId] = useState<string | null>(null);

	const drill = useApi<TopicMemoriesResponse>(
		useCallback(
			() =>
				drillTopicId ? fetchTopicMemories(drillTopicId) : Promise.reject(),
			[drillTopicId],
		),
		{ pollInterval: 0 },
	);

	const filtered = useMemo(() => {
		if (!data) return [];
		const q = query.trim().toLowerCase();
		if (!q) return data.topics;
		return data.topics.filter(
			(t) =>
				t.label.toLowerCase().includes(q) ||
				t.termScore.some((s) => s.term.toLowerCase().includes(q)),
		);
	}, [data, query]);

	if (error && !data) {
		return (
			<div className="tab-stub">Error loading topics: {error.message}</div>
		);
	}
	if (loading && !data) {
		return <div className="tab-stub">Loading topics…</div>;
	}
	if (!data) {
		return <div className="tab-stub">No topic data available.</div>;
	}

	if (data.totalTopics === 0) {
		return (
			<div className="tab-stub">
				<h3>Wiki</h3>
				<p>
					No topics yet. Topics are auto-generated after every 10th compaction
					from real memory embeddings (k-means + TF-IDF).
				</p>
				<p>Check back after a few more compaction cycles.</p>
			</div>
		);
	}

	return (
		<div className="tab-content topics-tab">
			<h3>Wiki</h3>
			<p className="subtitle">
				{data.totalTopics} topic{data.totalTopics !== 1 ? "s" : ""} ·{" "}
				{data.totalAssigned} assigned memori
				{data.totalAssigned !== 1 ? "es" : "y"}
				{data.lastRebuildAt != null && (
					<> · last rebuild {new Date(data.lastRebuildAt).toLocaleString()}</>
				)}
			</p>

			<input
				type="search"
				className="topics-search"
				placeholder="Filter topics by label or term…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>

			{drillTopicId && (
				<section className="topic-drilldown">
					<h4>
						<button
							type="button"
							className="link-btn"
							onClick={() => setDrillTopicId(null)}
						>
							← back
						</button>{" "}
						Topic <code>{drillTopicId}</code>
						{drill.data && <> · {drill.data.label}</>}
						{drill.data && <> · {drill.data.assignments.length} memories</>}
					</h4>
					{drill.error ? (
						<div className="tab-stub">
							Error: {(drill.error as Error).message}
						</div>
					) : drill.loading && !drill.data ? (
						<div className="tab-stub">Loading memories…</div>
					) : drill.data ? (
						<table className="data-table">
							<thead>
								<tr>
									<th>Memory id</th>
									<th>Confidence</th>
									<th>Assigned</th>
								</tr>
							</thead>
							<tbody>
								{drill.data.assignments.map((a) => (
									<tr key={a.memoryId}>
										<td>
											<code>{a.memoryId}</code>
										</td>
										<td>
											{a.confidence != null ? a.confidence.toFixed(2) : "—"}
										</td>
										<td>{fmtTs(a.assignedAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
				</section>
			)}

			{!drillTopicId && (
				<table className="data-table">
					<thead>
						<tr>
							<th>Label</th>
							<th>Memories</th>
							<th>Top Terms</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{filtered.map((t) => (
							<tr
								key={t.id}
								className="topic-row"
								onClick={() => setDrillTopicId(t.id)}
								style={{ cursor: "pointer" }}
							>
								<td className="topic-label">{t.label}</td>
								<td className="topic-count">{t.memoryCount}</td>
								<td className="topic-terms">
									{t.termScore
										.slice(0, 8)
										.map((s) => s.term)
										.join(", ")}
								</td>
								<td>
									<button type="button" className="mini-btn">
										drill
									</button>
								</td>
							</tr>
						))}
						{filtered.length === 0 && (
							<tr>
								<td colSpan={4} className="muted">
									No topics match “{query}”.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
		</div>
	);
}
