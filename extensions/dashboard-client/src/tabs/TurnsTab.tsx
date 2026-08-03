/**
 * dashboard-client/src/tabs/TurnsTab.tsx — Turn-by-turn memory tracking + recall (S52).
 *
 * Fetches /api/turns (conversation list), expands the active conversation into
 * per-turn detail (/api/turns/conversation/:id), and renders:
 *   - Conversation summary list (turn count, recall total, epochs, last turn).
 *   - Per-turn rows: turn index, role, ctx tokens/percent + pressure band,
 *     epoch id, and the injected-checkpoint recall set (the memory recalled
 *     at each turn, with score + source).
 *   - Pending rewind intents (S52A) + Fork action (S50C primitive).
 *
 * Read-mostly via /api/turns; fork/intent/prune via POST. No absolute URLs
 * (PREVENT-PI-004: loopback-only, same-origin static bundle).
 */

import type React from "react";
import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import {
	fetchTurns,
	fetchConversationTurns,
	fetchTurnIntents,
	postFork,
	postTurnIntent,
} from "../api/client";
import type {
	TurnsResponse,
	ConversationTurnsResponse,
	RewindIntentsResponse,
	TurnRow,
	ConversationSummary,
} from "@contracts";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

function fmtTs(ms: number): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}

function bandVariant(band: TurnRow["pressureBand"]): "success" | "warning" | "danger" | "default" {
	if (band === "green") return "success";
	if (band === "yellow") return "warning";
	if (band === "red") return "danger";
	return "default";
}

function sourceLabel(s: TurnRow["recall"][number]["source"]): string {
	if (s === "checkpoint") return "ckpt";
	if (s === "cluster_summary") return "raptor";
	return "mem";
}

export default function TurnsTab(): React.ReactElement {
	const {
		data: turns,
		loading,
		error,
	} = useApi<TurnsResponse>(
		useCallback(() => fetchTurns(), []),
		{
			pollInterval: 10_000,
		},
	);
	const { data: intents } = useApi<RewindIntentsResponse>(
		useCallback(() => fetchTurnIntents(), []),
		{ pollInterval: 5_000 },
	);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [detail, setDetail] = useState<ConversationTurnsResponse | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const expand = useCallback(
		async (conversationId: string) => {
			if (expanded === conversationId) {
				setExpanded(null);
				setDetail(null);
				return;
			}
			setExpanded(conversationId);
			setDetailLoading(true);
			setDetail(null);
			try {
				const d = await fetchConversationTurns(conversationId);
				setDetail(d);
			} finally {
				setDetailLoading(false);
			}
		},
		[expanded],
	);

	const onFork = useCallback(
		async (conversationId: string, turnIndex: number) => {
			setBusy(`fork:${conversationId}:${turnIndex}`);
			setNotice(null);
			try {
				const out = await postFork(conversationId, turnIndex);
				setNotice(
					`Forked → ${out.childConversationId} (${out.recalledCount} recalled)`,
				);
			} catch (e) {
				setNotice(`Fork failed: ${(e as Error).message}`);
			} finally {
				setBusy(null);
			}
		},
		[],
	);

	const onRewind = useCallback(
		async (conversationId: string, turnIndex: number) => {
			setBusy(`rewind:${conversationId}:${turnIndex}`);
			setNotice(null);
			try {
				await postTurnIntent(conversationId, turnIndex);
				setNotice(`Rewind intent queued for turn ${turnIndex}`);
			} catch (e) {
				setNotice(`Rewind failed: ${(e as Error).message}`);
			} finally {
				setBusy(null);
			}
		},
		[],
	);

	if (error && !turns) {
		return <div className="tab-stub">Error loading turns: {error.message}</div>;
	}
	if (loading && !turns) {
		return <div className="tab-stub">Loading turns…</div>;
	}
	if (!turns || turns.conversations.length === 0) {
		return (
			<div className="tab-stub">
				<h3>Turn-by-turn memory</h3>
				<p>
					No turns recorded yet. Per-turn tracking starts when{" "}
					<code>MEGACOMPACT_TURNS_DB=1</code> and the session runs through a
					compaction. Each turn records its context metrics + the checkpoints
					recalled into it.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<h3 className="font-heading text-lg font-semibold">
				Turn-by-turn memory tracking + recall
			</h3>
			{notice && <Badge variant="warning">{notice}</Badge>}

			{intents && intents.intents.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>
							Pending rewind intents ({intents.intents.length})
						</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="list-disc space-y-1 pl-5">
							{intents.intents.map((i) => (
								<li key={i.id}>
									{fmtTs(i.createdAt)} — rewind{" "}
									<code>{i.conversationId}</code> to turn {i.targetTurnIndex}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>
						Conversations ({turns.conversations.length})
					</CardTitle>
				</CardHeader>
				<CardContent>
					<table className="w-full border-collapse text-sm">
						<thead>
							<tr>
								<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Conversation</th>
								<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Turns</th>
								<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Recall</th>
								<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Epochs</th>
								<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Avg ctx%</th>
								<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Last turn</th>
								<th className="border-b border-border px-3 py-2"></th>
							</tr>
						</thead>
						<tbody>
							{turns.conversations.map((c: ConversationSummary) => (
								<ConversationRow
									key={c.conversationId}
									c={c}
									active={turns.activeConversationId === c.conversationId}
									expanded={expanded === c.conversationId}
									onExpand={() => expand(c.conversationId)}
								/>
							))}
						</tbody>
					</table>
				</CardContent>
			</Card>

			{expanded && (
				<Card>
					<CardHeader>
						<CardTitle>
							Turns in <code>{expanded}</code>
						</CardTitle>
					</CardHeader>
					<CardContent>
						{detailLoading ? (
							<div className="text-sm text-muted-foreground">Loading turns…</div>
						) : detail ? (
							<TurnDetail
								detail={detail}
								busy={busy}
								onFork={onFork}
								onRewind={onRewind}
							/>
						) : (
							<div className="text-sm text-muted-foreground">No detail.</div>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function ConversationRow({
	c,
	active,
	expanded,
	onExpand,
}: {
	c: ConversationSummary;
	active: boolean;
	expanded: boolean;
	onExpand: () => void;
}): React.ReactElement {
	return (
		<>
			<tr
				className={`border-b border-border/50 hover:bg-bg-elevated/40 ${
					active ? "bg-primary/10" : ""
				}`}
				onClick={onExpand}
				style={{ cursor: "pointer" }}
			>
				<td className="px-3 py-2">
					{expanded ? "▾" : "▸"} <code>{c.conversationId}</code>
					{active && <Badge variant="accent" className="ml-2">active</Badge>}
				</td>
				<td className="px-3 py-2 text-right">{c.turnCount}</td>
				<td className="px-3 py-2 text-right">{c.totalRecall}</td>
				<td className="px-3 py-2 text-right">{c.epochCount}</td>
				<td className="px-3 py-2 text-right">{c.avgCtxPercent.toFixed(0)}%</td>
				<td className="px-3 py-2">{fmtTs(c.lastTurnAt)}</td>
				<td className="px-3 py-2" />
			</tr>
		</>
	);
}

function TurnDetail({
	detail,
	busy,
	onFork,
	onRewind,
}: {
	detail: ConversationTurnsResponse;
	busy: string | null;
	onFork: (conversationId: string, turnIndex: number) => void;
	onRewind: (conversationId: string, turnIndex: number) => void;
}): React.ReactElement {
	return (
		<table className="w-full border-collapse text-sm">
			<thead>
				<tr>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">#</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Ctx</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Band</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Epoch</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Recalled checkpoints (memory recall)</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Ended</th>
					<th className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">Actions</th>
				</tr>
			</thead>
			<tbody>
				{detail.turns.map((t) => (
					<tr
						key={`${t.conversationId}:${t.turnIndex}`}
						className="border-b border-border/50 hover:bg-bg-elevated/40"
					>
						<td className="px-3 py-2 text-right">{t.turnIndex}</td>
						<td className="px-3 py-2">{t.role}</td>
						<td className="px-3 py-2">
							{t.ctxTokens ?? "—"}
							{t.ctxPercent != null && (
								<span className="text-muted-foreground">
									{" "}
									· {t.ctxPercent.toFixed(0)}%
								</span>
							)}
						</td>
						<td className="px-3 py-2">
							<Badge variant={bandVariant(t.pressureBand)}>
								{t.pressureBand ?? "—"}
							</Badge>
						</td>
						<td className="px-3 py-2">{t.epochId ? <code>{t.epochId.slice(0, 8)}</code> : "—"}</td>
						<td className="px-3 py-2">
							{t.recall.length === 0 ? (
								<span className="text-muted-foreground">—</span>
							) : (
								<ul className="space-y-1">
									{t.recall.map((r) => (
										<li key={r.checkpointId}>
											<code>{r.checkpointId.slice(0, 12)}</code>{" "}
											<span className="text-muted-foreground">
												{sourceLabel(r.source)} · {r.score.toFixed(2)}
												{r.raptorLevel != null ? ` · L${r.raptorLevel}` : ""}
											</span>
										</li>
									))}
								</ul>
							)}
						</td>
						<td className="px-3 py-2">{fmtTs(t.endedAt)}</td>
						<td className="px-3 py-2">
							<div className="flex gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() => onFork(t.conversationId, t.turnIndex)}
								>
									fork
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() => onRewind(t.conversationId, t.turnIndex)}
								>
									rewind
								</Button>
							</div>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
