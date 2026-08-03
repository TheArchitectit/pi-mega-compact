/**
 * dashboard-client/src/tabs/WikiTab/WikiPage.tsx — single wiki topic page.
 *
 * Renders the extractive summary, key member memories, the member provenance
 * table (memory → session/assigned-at/method), related topics (resolved from
 * the wiki index), and the per-topic memory timeline. Mutations
 * (rename/merge/split) delegate to WikiPageControls; on mutation success the
 * page + index are refetched.
 *
 * Styling: Tailwind + shadcn (Card, Badge, Button) — no legacy CSS.
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { fetchWikiTopic, fetchWikiIndex } from "../../api/client";
import type { WikiPageResponse, WikiIndexResponse } from "@contracts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import WikiPageControls from "./WikiPageControls";
import TopicTimeline from "./TopicTimeline";

interface WikiPageProps {
	topicId: string;
	onBack: () => void;
}

function fmtTs(ms: number): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}

const METHOD_LABELS: Record<string, string> = {
	"kmeans+tfidf": "kmeans",
	merge: "merge",
	split: "split",
	manual: "manual",
};

export default function WikiPage({
	topicId,
	onBack,
}: WikiPageProps): React.ReactElement {
	const [dirty, setDirty] = useState(0);
	const bump = useCallback(() => setDirty((d) => d + 1), []);

	const { data: page, error, loading } = useApi<WikiPageResponse>(
		useCallback(() => fetchWikiTopic(topicId), [topicId, dirty]),
		{},
	);
	const { data: index } = useApi<WikiIndexResponse>(
		useCallback(() => fetchWikiIndex(), []),
		{},
	);

	const labelOf = useMemo(() => {
		const map = new Map<string, string>();
		for (const t of index?.topics ?? []) map.set(t.id, t.label);
		return map;
	}, [index]);

	if (error && !page) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-danger">
				Error loading topic: {error.message}
			</div>
		);
	}
	if (loading && !page) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				Loading topic…
			</div>
		);
	}
	if (!page) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				No topic data available.
			</div>
		);
	}

	const otherTopics = (index?.topics ?? [])
		.filter((t) => t.id !== topicId)
		.map((t) => ({ id: t.id, label: t.label }));

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={onBack}>
						← Wiki
					</Button>
					<h2 className="font-heading text-lg font-semibold">
						{page.topic.label}
					</h2>
					{page.topic.edited && <Badge variant="outline">edited</Badge>}
					<Badge variant="default">
						{page.provenance.length} memories
					</Badge>
				</div>
				<WikiPageControls
					topicId={topicId}
					others={otherTopics}
					members={page.provenance}
					onMutated={bump}
				/>
			</div>

			{page.summary && (
				<Card>
					<CardContent>
						<h3 className="mb-1 font-heading text-sm font-semibold text-muted-foreground">
							Summary
						</h3>
						<p className="text-sm leading-relaxed text-foreground/90">
							{page.summary}
						</p>
					</CardContent>
				</Card>
			)}

			{page.keyMemories.length > 0 && (
				<Card>
					<CardContent>
						<h3 className="mb-2 font-heading text-sm font-semibold text-muted-foreground">
							Key memories
						</h3>
						<ul className="flex flex-col gap-2">
							{page.keyMemories.map((m) => (
								<li
									key={m.memoryId}
									className="rounded-md border border-border/60 bg-bg-elevated/40 p-3 text-sm"
								>
									<p className="line-clamp-3 text-foreground/90">{m.content}</p>
									<p className="mt-1 text-xs text-muted-foreground">
										{m.memoryId} · {fmtTs(m.timestamp)}
									</p>
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}

			<TopicTimeline topicId={topicId} />

			{page.provenance.length > 0 && (
				<Card>
					<CardContent>
						<h3 className="mb-2 font-heading text-sm font-semibold text-muted-foreground">
							Provenance
						</h3>
						<div className="max-h-72 overflow-auto rounded-md border border-border/60">
							<table className="w-full text-sm">
								<thead className="sticky top-0 bg-bg-card">
									<tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
										<th className="px-3 py-2 font-medium">Memory</th>
										<th className="px-3 py-2 font-medium">Session</th>
										<th className="px-3 py-2 font-medium">Assigned</th>
										<th className="px-3 py-2 font-medium">Method</th>
									</tr>
								</thead>
								<tbody>
									{page.provenance.map((p) => (
										<tr
											key={p.memoryId}
											className="border-b border-border/40 last:border-0"
										>
											<td className="px-3 py-1.5 font-mono text-xs">
												{p.memoryId}
											</td>
											<td className="px-3 py-1.5 text-xs text-muted-foreground">
												{p.sessionId || "unknown"}
											</td>
											<td className="px-3 py-1.5 text-xs text-muted-foreground">
												{fmtTs(p.assignedAt)}
											</td>
											<td className="px-3 py-1.5">
												<Badge variant="outline">
													{METHOD_LABELS[p.method] ?? p.method}
												</Badge>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</CardContent>
				</Card>
			)}

			{page.relatedTopicIds.length > 0 && (
				<Card>
					<CardContent>
						<h3 className="mb-2 font-heading text-sm font-semibold text-muted-foreground">
							Related topics
						</h3>
						<div className="flex flex-wrap gap-2">
							{page.relatedTopicIds.map((id) => (
								<Badge key={id} variant="accent">
									{labelOf.get(id) ?? id}
								</Badge>
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
