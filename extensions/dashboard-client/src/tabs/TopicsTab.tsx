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
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";

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
			<div className="rounded-lg border border-border bg-bg-card p-4 text-sm text-foreground">
				Error loading topics: {error.message}
			</div>
		);
	}
	if (loading && !data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-4 text-sm text-muted-foreground">
				Loading topics…
			</div>
		);
	}
	if (!data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-4 text-sm text-muted-foreground">
				No topic data available.
			</div>
		);
	}

	if (data.totalTopics === 0) {
		return (
			<Card className="p-4">
				<h3 className="font-heading text-lg font-semibold">Wiki</h3>
				<p className="mt-2 text-sm">
					No topics yet. Topics are auto-generated after every 3rd compaction
					from real memory embeddings (k-means + TF-IDF).
				</p>
				<p className="mt-2 text-sm text-muted-foreground">
					Check back after a few more compaction cycles.
				</p>
			</Card>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<h3 className="font-heading text-lg font-semibold">Wiki</h3>
			<p className="text-sm text-muted-foreground">
				{data.totalTopics} topic{data.totalTopics !== 1 ? "s" : ""} ·{" "}
				{data.totalAssigned} assigned memori
				{data.totalAssigned !== 1 ? "es" : "y"}
				{data.lastRebuildAt != null && (
					<> · last rebuild {new Date(data.lastRebuildAt).toLocaleString()}</>
				)}
			</p>

			<input
				type="search"
				className="mb-1 w-full max-w-sm rounded-md border border-border bg-bg-elevated/50 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
				placeholder="Filter topics by label or term…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>

			{drillTopicId && (
				<Card>
					<h4 className="flex items-center gap-2 font-heading text-base font-semibold">
						<button
							type="button"
							className="text-sm text-muted-foreground transition-colors hover:text-foreground"
							onClick={() => setDrillTopicId(null)}
						>
							← back
						</button>
						Topic <code>{drillTopicId}</code>
						{drill.data && <> · {drill.data.label}</>}
						{drill.data && <> · {drill.data.assignments.length} memories</>}
					</h4>
					{drill.error ? (
						<div className="mt-2 text-sm text-foreground">
							Error: {(drill.error as Error).message}
						</div>
					) : drill.loading && !drill.data ? (
						<div className="mt-2 text-sm text-muted-foreground">
							Loading memories…
						</div>
					) : drill.data ? (
						<table className="mt-2 w-full border-collapse text-sm">
							<thead>
								<tr>
									<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
										Memory id
									</th>
									<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
										Confidence
									</th>
									<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
										Assigned
									</th>
								</tr>
							</thead>
							<tbody>
								{drill.data.assignments.map((a) => (
									<tr key={a.memoryId} className="border-b border-border/50">
										<td className="px-3 py-2">
											<code>{a.memoryId}</code>
										</td>
										<td className="px-3 py-2">
											{a.confidence != null ? a.confidence.toFixed(2) : "—"}
										</td>
										<td className="px-3 py-2">{fmtTs(a.assignedAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
				</Card>
			)}

			{!drillTopicId && (
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr>
							<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
								Label
							</th>
							<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
								Memories
							</th>
							<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
								Top Terms
							</th>
							<th className="border-b border-border px-3 py-2 text-right font-medium text-muted-foreground"></th>
						</tr>
					</thead>
					<tbody>
						{filtered.map((t) => (
							<tr
								key={t.id}
								className="cursor-pointer border-b border-border/50 transition-colors hover:bg-bg-elevated/40"
								onClick={() => setDrillTopicId(t.id)}
							>
								<td className="px-3 py-2 font-semibold">{t.label}</td>
								<td className="px-3 py-2">
									<Badge variant="accent">{t.memoryCount}</Badge>
								</td>
								<td className="px-3 py-2 text-muted-foreground">
									{t.termScore
										.slice(0, 8)
										.map((s) => s.term)
										.join(", ")}
								</td>
								<td className="px-3 py-2 text-right">
									<button
										type="button"
										className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-bg-elevated/40 hover:text-foreground"
									>
										drill
									</button>
								</td>
							</tr>
						))}
						{filtered.length === 0 && (
							<tr>
								<td
									colSpan={4}
									className="px-3 py-2 text-sm text-muted-foreground"
								>
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
