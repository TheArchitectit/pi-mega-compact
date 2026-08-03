/**
 * dashboard-client/src/tabs/WikiTab/TopicEvolutionView.tsx — planet evolution.
 *
 * Thin shell over TopicEvolutionGraph: fetches GET /api/wiki/evolution via
 * useApi and refetches when a `wiki_rebuilt` SSE event lands (emitted by the
 * extension after a topic-model rebuild), so the graph + scrubber stay live
 * between polls. No data is fabricated — only the contract fields are used.
 *
 * Styling: Tailwind + shadcn (Card). No legacy CSS classes.
 */

import type React from "react";
import { useCallback, useEffect, useMemo } from "react";
import { useApi } from "../../hooks/useApi";
import { useSSE } from "../../hooks/useSSE";
import { fetchTopicEvolution } from "../../api/client";
import type { TopicEvolutionResponse, SseEvent } from "@contracts";
import { Card, CardContent } from "../../components/ui/card";
import TopicEvolutionGraph from "./TopicEvolutionGraph";

function isWikiRebuilt(e: SseEvent): e is Extract<SseEvent, { type: "wiki_rebuilt" }> {
	return e.type === "wiki_rebuilt";
}

export default function TopicEvolutionView(): React.ReactElement {
	const { data, error, loading, refetch } = useApi<TopicEvolutionResponse>(
		useCallback(() => fetchTopicEvolution(), []),
		{ pollInterval: 60_000 },
	);

	const { events } = useSSE();
	const lastRebuiltTs = useMemo(() => {
		const rebuilt = events.filter(isWikiRebuilt);
		if (rebuilt.length === 0) return null;
		return rebuilt[rebuilt.length - 1].ts;
	}, [events]);

	useEffect(() => {
		if (lastRebuiltTs != null) refetch();
	}, [lastRebuiltTs, refetch]);

	if (error && !data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-danger">
				Error loading evolution graph: {error.message}
			</div>
		);
	}
	if (loading && !data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				Loading evolution graph…
			</div>
		);
	}

	return (
		<Card>
			<CardContent>
				<h3 className="mb-2 font-heading text-sm font-semibold text-muted-foreground">
					Topic evolution
				</h3>
				{data ? (
					<TopicEvolutionGraph data={data} />
				) : (
					<p className="text-sm text-muted-foreground">No data yet.</p>
				)}
			</CardContent>
		</Card>
	);
}
