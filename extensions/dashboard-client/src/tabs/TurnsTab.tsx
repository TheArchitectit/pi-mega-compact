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

function fmtTs(ms: number): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}

function bandClass(band: TurnRow["pressureBand"]): string {
	if (band === "green") return "band band-green";
	if (band === "yellow") return "band band-yellow";
	if (band === "red") return "band band-red";
	return "band";
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
		<div className="turns-tab">
			<h3>Turn-by-turn memory tracking + recall</h3>
			{notice && <div className="turns-notice">{notice}</div>}

			{intents && intents.intents.length > 0 && (
				<section className="turns-intents">
					<h4>Pending rewind intents ({intents.intents.length})</h4>
					<ul>
						{intents.intents.map((i) => (
							<li key={i.id}>
								{fmtTs(i.createdAt)} — rewind <code>{i.conversationId}</code> to
								turn {i.targetTurnIndex}
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="turns-conv-list">
				<h4>Conversations ({turns.conversations.length})</h4>
				<table className="turns-table">
					<thead>
						<tr>
							<th>Conversation</th>
							<th>Turns</th>
							<th>Recall</th>
							<th>Epochs</th>
							<th>Avg ctx%</th>
							<th>Last turn</th>
							<th></th>
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
			</section>

			{expanded && (
				<section className="turns-detail">
					<h4>
						Turns in <code>{expanded}</code>
					</h4>
					{detailLoading ? (
						<div className="tab-stub">Loading turns…</div>
					) : detail ? (
						<TurnDetail
							detail={detail}
							busy={busy}
							onFork={onFork}
							onRewind={onRewind}
						/>
					) : (
						<div className="tab-stub">No detail.</div>
					)}
				</section>
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
				className={active ? "turns-row active" : "turns-row"}
				onClick={onExpand}
				style={{ cursor: "pointer" }}
			>
				<td>
					{expanded ? "▾" : "▸"} <code>{c.conversationId}</code>
					{active && <span className="pill">active</span>}
				</td>
				<td>{c.turnCount}</td>
				<td>{c.totalRecall}</td>
				<td>{c.epochCount}</td>
				<td>{c.avgCtxPercent.toFixed(0)}%</td>
				<td>{fmtTs(c.lastTurnAt)}</td>
				<td />
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
		<table className="turns-detail-table">
			<thead>
				<tr>
					<th>#</th>
					<th>Role</th>
					<th>Ctx</th>
					<th>Band</th>
					<th>Epoch</th>
					<th>Recalled checkpoints (memory recall)</th>
					<th>Ended</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{detail.turns.map((t) => (
					<tr key={`${t.conversationId}:${t.turnIndex}`}>
						<td>{t.turnIndex}</td>
						<td>{t.role}</td>
						<td>
							{t.ctxTokens ?? "—"}
							{t.ctxPercent != null && (
								<span className="muted">
									{" "}
									· {t.ctxPercent.toFixed(0)}%
								</span>
							)}
						</td>
						<td>
							<span className={bandClass(t.pressureBand)}>
								{t.pressureBand ?? "—"}
							</span>
						</td>
						<td>{t.epochId ? <code>{t.epochId.slice(0, 8)}</code> : "—"}</td>
						<td className="recall-cell">
							{t.recall.length === 0 ? (
								<span className="muted">—</span>
							) : (
								<ul className="recall-list">
									{t.recall.map((r) => (
										<li key={r.checkpointId}>
											<code>{r.checkpointId.slice(0, 12)}</code>{" "}
											<span className="muted">
												{sourceLabel(r.source)} · {r.score.toFixed(2)}
												{r.raptorLevel != null ? ` · L${r.raptorLevel}` : ""}
											</span>
										</li>
									))}
								</ul>
							)}
						</td>
						<td>{fmtTs(t.endedAt)}</td>
						<td className="actions-cell">
							<button
								type="button"
								className="mini-btn"
								disabled={busy !== null}
								onClick={() => onFork(t.conversationId, t.turnIndex)}
							>
								fork
							</button>
							<button
								type="button"
								className="mini-btn"
								disabled={busy !== null}
								onClick={() => onRewind(t.conversationId, t.turnIndex)}
							>
								rewind
							</button>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
