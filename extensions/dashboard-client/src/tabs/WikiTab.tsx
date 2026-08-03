/**
 * dashboard-client/src/tabs/WikiTab.tsx — Wiki Revival (W3): wiki landing list.
 *
 * Replaces TopicsTab in the App registry (TopicsTab.tsx kept, unused). Renders
 * the wiki index: each auto-categorized topic with its resolved label (edited
 * badge when user-renamed), member count, curation badges (label/merge/split),
 * and a click-to-open that pushes a client-side page state to WikiPage.
 *
 * Styling is Tailwind + shadcn (Card, Badge, Button) — no legacy CSS classes.
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { fetchWikiIndex } from "../api/client";
import type { WikiIndexEntry, WikiIndexResponse } from "@contracts";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Toggle } from "../components/ui/toggle";
import WikiPage from "./WikiTab/WikiPage";
import TopicEvolutionView from "./WikiTab/TopicEvolutionView";

type WikiView = "list" | "evolution";

const KIND_BADGES: Record<string, "default" | "accent" | "warning"> = {
	label: "accent",
	merge: "warning",
	split: "default",
};

function fmtTs(ms: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}

function ViewToggle({
	view,
	onChange,
}: {
	view: WikiView;
	onChange: (v: WikiView) => void;
}): React.ReactElement {
	return (
		<div className="flex gap-1">
			<Toggle pressed={view === "list"} onClick={() => onChange("list")}>
				Topics
			</Toggle>
			<Toggle
				pressed={view === "evolution"}
				onClick={() => onChange("evolution")}
			>
				Evolution
			</Toggle>
		</div>
	);
}

interface RowProps {
	entry: WikiIndexEntry;
	onOpen: (id: string) => void;
}

function TopicRow({ entry, onOpen }: RowProps): React.ReactElement {
	return (
		<tr className="border-b border-border/60 last:border-0 hover:bg-bg-elevated/40">
			<td className="py-2 pr-3">
				<div className="flex items-center gap-2">
					<span className="font-medium text-foreground">{entry.label}</span>
					{entry.edited && <Badge variant="outline">edited</Badge>}
				</div>
			</td>
			<td className="py-2 pr-3 text-sm text-muted-foreground">
				{entry.memoryCount}
			</td>
			<td className="py-2 pr-3">
				<div className="flex flex-wrap gap-1">
					{entry.overrideKinds.map((k) => (
						<Badge key={k} variant={KIND_BADGES[k] ?? "default"}>
							{k}
						</Badge>
					))}
				</div>
			</td>
			<td className="py-2 pr-3 text-xs text-muted-foreground">
				{fmtTs(entry.lastUpdated)}
			</td>
			<td className="py-2 text-right">
				<Button
					variant="outline"
					size="sm"
					onClick={() => onOpen(entry.id)}
				>
					Open
				</Button>
			</td>
		</tr>
	);
}

export default function WikiTab(): React.ReactElement {
	const { data, loading, error } = useApi<WikiIndexResponse>(
		useCallback(() => fetchWikiIndex(), []),
		{ pollInterval: 30_000 },
	);
	const [view, setView] = useState<WikiView>("list");
	const [query, setQuery] = useState("");
	const [openId, setOpenId] = useState<string | null>(null);

	const filtered = useMemo(() => {
		if (!data) return [];
		const q = query.trim().toLowerCase();
		if (!q) return data.topics;
		return data.topics.filter((t) =>
			t.label.toLowerCase().includes(q),
		);
	}, [data, query]);

	if (openId) {
		return <WikiPage topicId={openId} onBack={() => setOpenId(null)} />;
	}

	if (view === "evolution") {
		return (
			<div className="flex flex-col gap-3">
				<ViewToggle view={view} onChange={setView} />
				<TopicEvolutionView />
			</div>
		);
	}

	if (error && !data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-danger">
				Error loading wiki: {error.message}
			</div>
		);
	}
	if (loading && !data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				Loading wiki…
			</div>
		);
	}
	if (!data) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				No wiki data available.
			</div>
		);
	}
	if (data.totalTopics === 0) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				<h3 className="mb-2 font-heading text-base text-foreground">Wiki</h3>
				<p>
					No topics yet. Topics are auto-generated after every Nth compaction
					from real memory embeddings (k-means + TF-IDF).
				</p>
				<p className="mt-2">Check back after a few more compaction cycles.</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-2">
				<div className="flex items-center gap-3">
					<ViewToggle view={view} onChange={setView} />
					<div>
						<h2 className="font-heading text-lg font-semibold">Wiki</h2>
						<p className="text-sm text-muted-foreground">
							{data.totalTopics} topic{data.totalTopics !== 1 ? "s" : ""} ·{" "}
							{data.totalMemories} assigned memori
							{data.totalMemories !== 1 ? "es" : "y"}
							{data.lastRebuildAt != null && (
								<> · last rebuild {fmtTs(data.lastRebuildAt)}</>
							)}
						</p>
					</div>
				</div>
				<input
					type="search"
					placeholder="Filter topics by label…"
					aria-label="Filter topics by label"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="w-64 rounded-md border border-border bg-bg-elevated/50 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
				/>
			</div>

			<div className="overflow-x-auto rounded-lg border border-border bg-bg-card">
				<table className="w-full table-fixed text-sm">
					<thead>
						<tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
							<th className="w-1/3 px-4 py-2 font-medium">Label</th>
							<th className="w-16 py-2 font-medium">Memories</th>
							<th className="w-40 py-2 font-medium">Badges</th>
							<th className="w-40 py-2 font-medium">Last updated</th>
							<th className="w-20 py-2" />
						</tr>
					</thead>
					<tbody>
						{filtered.map((t) => (
							<TopicRow key={t.id} entry={t} onOpen={setOpenId} />
						))}
						{filtered.length === 0 && (
							<tr>
								<td
									colSpan={5}
									className="px-4 py-6 text-center text-muted-foreground"
								>
									No topics match "{query}".
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
