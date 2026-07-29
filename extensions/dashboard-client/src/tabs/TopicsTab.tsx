/**
 * dashboard-client/src/tabs/TopicsTab.tsx — Auto-categorizing wiki topics (S51).
 *
 * Fetches /api/topics and renders a table of k-means + TF-IDF topic clusters
 * with memory counts, labels, and top discriminative terms. Read-only;
 * no write operations.
 */

import type React from "react";
import { useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { fetchTopics } from "../api/client";
import type { TopicsResponse } from "@contracts";

export default function TopicsTab(): React.ReactElement {
	const { data, loading, error } = useApi<TopicsResponse>(
		useCallback(() => fetchTopics(), []),
		{ pollInterval: 30_000 },
	);

	if (error && !data) {
		return <div className="tab-stub">Error loading topics: {error.message}</div>;
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
				<h3>Wiki Topics</h3>
				<p>No topics yet. Topics are auto-generated after every 10th compaction from real memory embeddings (k-means + TF-IDF).</p>
				<p>Check back after a few more compaction cycles.</p>
			</div>
		);
	}

	return (
		<div className="tab-content">
			<h3>Wiki Topics</h3>
			<p className="subtitle">
				{data.totalTopics} topic{data.totalTopics !== 1 ? "s" : ""} ·{" "}
				{data.totalAssigned} assigned memori{data.totalAssigned !== 1 ? "es" : "y"}
				{data.lastRebuildAt != null && (
					<> · last rebuild {new Date(data.lastRebuildAt).toLocaleString()}</>
				)}
			</p>
			<table className="data-table">
				<thead>
					<tr>
						<th>Label</th>
						<th>Memories</th>
						<th>Top Terms</th>
					</tr>
				</thead>
				<tbody>
					{data.topics.map((t) => (
						<tr key={t.id}>
							<td className="topic-label">{t.label}</td>
							<td className="topic-count">{t.memoryCount}</td>
							<td className="topic-terms">
								{t.termScore.slice(0, 8).map((s) => s.term).join(", ")}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
