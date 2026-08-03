/**
 * dashboard-client/src/tabs/OverviewTab.tsx — Overview tab (full spec).
 *
 * Renders all 11 cards from the spec:
 *  1. Context Window (ContextGauge)
 *  2. Trigger Status (TriggerStatus)
 *  3. Vector Store (session) (VectorStoreCard)
 *  4. Repo (all sessions) (RepoAllSessionsCard)
 *  5. Data Safety (DataSafetyCard)
 *  6. Configuration (ConfigSummaryCard)
 *  7. Model & Cost Savings (CacheStatusPerModel)
 *  8. Crew / Agents (SessionInfo)
 *  9. Cache Hits & Compactions (CacheHitsCard)
 * 10. Time Saved (TimeSavedCard)
 * 11. Legend (LegendCard)
 *
 * All data comes from the snapshot prop passed by App.tsx.
 */

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import { fetchSessions, fetchPerfSamples } from "../api/client";
import type {
	SnapshotResponse,
	SseEvent,
	SseSessionSample,
	SessionsResponse,
} from "@contracts";
import type { RuntimeSnapshot } from "../utils/types";
import { RepoContextStack } from "../components/RepoContextStack";
import { SessionContextGauges } from "../components/SessionContextGauges";
import { TriggerStatus } from "../components/TriggerStatus";
import { VectorStoreCard } from "../components/VectorStoreCard";
import { RepoAllSessionsCard } from "../components/RepoAllSessionsCard";
import { DataSafetyCard } from "../components/DataSafetyCard";
import { ConfigSummaryCard } from "../components/ConfigSummaryCard";
import { CacheStatusPerModel } from "../components/CacheStatusPerModel";
import { SessionInfo } from "../components/SessionInfo";
import { CacheHitsCard } from "../components/CacheHitsCard";
import { TimeSavedCard } from "../components/TimeSavedCard";
import { LegendCard } from "../components/LegendCard";
import { Badge } from "../components/ui/badge";
import { NEW_UI } from "../config";
import RagHealthCard from "./SetupTab/RagHealthCard";
import { WidgetDetailModal } from "../components/WidgetDetailModal";
import { PerfLineChart } from "../components/charts/PerfLineChart";
import { PerfBarChart } from "../components/charts/PerfBarChart";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { CardId } from "../types/card";
import { useCardPositions } from "../hooks/useCardPositions";
import { SortableCard } from "../components/ui/SortableCard";

/** Type guard: narrows an SSE event to a session_sample event. */
function isSessionSample(e: SseEvent): e is SseSessionSample {
	return e.type === "session_sample";
}

/**
 * Maps a widget id to its perf sample kind (null for snapshot-backed widgets,
 * e.g. "model" which derives its drill-down from snapshot data in-component).
 */
function perfKindFor(widget: string): string | null {
	switch (widget) {
		case "cache":
			return "cache_hit_pct";
		case "vector":
			return "turn_latency_ms";
		case "time":
			return "disk_write_ms";
		default:
			return null;
	}
}

export interface OverviewTabProps {
	snapshot: SnapshotResponse | null;
	loading: boolean;
	error: Error | null;
}

function formatUpdatedAt(ts: string | null): string {
	if (!ts) return "never";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return ts;
	}
}

export default function OverviewTab({
	snapshot,
	loading,
	error,
}: OverviewTabProps): React.ReactElement {
	// S40: real-time per-repo context via /api/sessions + SSE. Mirrors the
	// SessionsTab pattern: 2s poll + session_sample SSE refetch.
	const {
		data: sessionsData,
		error: sessionsErr,
		loading: sessionsLoading,
		refetch: refetchSessions,
	} = useApi<SessionsResponse>(
		useCallback(() => fetchSessions(), []),
		{ pollInterval: 2_000 },
	);

	const { events } = useSSE();

	const sampleEvents = useMemo(() => events.filter(isSessionSample), [events]);
	const lastSampleTs = useMemo(() => {
		if (sampleEvents.length === 0) return null;
		return sampleEvents[sampleEvents.length - 1].ts;
	}, [sampleEvents]);

	useEffect(() => {
		if (lastSampleTs == null) return;
		refetchSessions();
	}, [lastSampleTs, refetchSessions]);

	// ── Widget drill-down state ─────────────────────────────────────────────
	// which widget's modal is open (null = none)
	const [openWidget, setOpenWidget] = useState<string | null>(null);
	// perf samples fetched for the opened perf-backed widget
	const [perfData, setPerfData] = useState<
		Array<{ ts: number; value: number }>
	>([]);
	const [perfLoading, setPerfLoading] = useState(false);
	const [perfError, setPerfError] = useState<Error | null>(null);

	useEffect(() => {
		setPerfData([]);
		setPerfError(null);

		const kind = openWidget ? perfKindFor(openWidget) : null;
		if (kind === null) {
			setPerfLoading(false);
			return;
		}

		let cancelled = false;
		setPerfLoading(true);
		fetchPerfSamples(kind, 60)
			.then((res) => {
				if (!cancelled) {
					setPerfData(res.samples.map((s) => ({ ts: s.ts, value: s.value })));
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setPerfError(err instanceof Error ? err : new Error(String(err)));
				}
			})
			.finally(() => {
				if (!cancelled) setPerfLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [openWidget]);

	// Drag-and-drop card reordering, persisted to localStorage.
	const { order, moveCard } = useCardPositions();

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (over && active.id !== over.id) {
				moveCard(active.id as CardId, over.id as CardId);
			}
		},
		[moveCard],
	);

	// Per-model cost breakdown for the Model & Cost drill-down, derived from
	// snapshot data already in the component (no snapshot.byModel exists).
	// MUST be called before the early returns below — Rules of Hooks: hooks
	// cannot be after a conditional return (would cause React error #310
	// "Rendered more hooks than during the previous render" when the snapshot
	// transitions from null → loaded). Guard the null case inline.
	const modelBarData = useMemo(
		() => {
			const ds = snapshot as RuntimeSnapshot | null;
			const compression = ds?.compression;
			const model = ds?.model;
			return [
				{ label: "Tokens freed", value: compression?.repo.tokensFreed ?? 0 },
				{ label: "Input rate", value: model ? model.inputRate : 0 },
				{ label: "Output rate", value: model ? model.outputRate : 0 },
			];
		},
		[snapshot],
	);

	if (loading && !snapshot)
		return <div className="tab-stub">Loading snapshot…</div>;
	if (error && !snapshot)
		return (
			<div className="tab-stub">
				<p>Error loading snapshot: {error.message}</p>
				<p className="text-xs text-muted-foreground mt-2">
					Auto-retried with backoff and will re-poll every 5s — no action
					needed.
				</p>
			</div>
		);
	if (!snapshot) return <div className="tab-stub">No snapshot data.</div>;

	// Cast to RuntimeSnapshot for tierPct (runtime-only field).
	const d = snapshot as RuntimeSnapshot;
	const { context, compression, trigger, session, store, tier, updatedAt } = d;
	const cfg = d.config;
	const crew = d.crew;
	const integrity = d.integrity;
	const cacheHits = d.cacheHits;
	const compacts = d.compacts;
	const timeSaved = d.timeSaved;
	const repo = d.repo;
	const model = d.model;

	// Renders a single card (wrapped in SortableCard) by its CardId. Cards
	// with a drill-down get an onClick; the rest are plain sortable items.
	const renderCard = (cardId: CardId): React.ReactNode => {
		switch (cardId) {
			case "trigger":
				return (
					<SortableCard id={cardId} onClick={() => setOpenWidget("cache")}>
						<TriggerStatus
							armed={trigger.armed}
							ready={trigger.ready}
							currentTokens={trigger.currentTokens}
							thresholdTokens={trigger.thresholdTokens}
							fastGatePct={trigger.fastGatePct}
						/>
					</SortableCard>
				);
			case "vector":
				return (
					<SortableCard id={cardId} onClick={() => setOpenWidget("vector")}>
						<VectorStoreCard
							checkpointCount={store.checkpointCount}
							tokensIn={compression.session.tokensIn}
							tokensOut={compression.session.tokensOut}
							tokensFreed={compression.session.tokensFreed}
							injectedCount={store.injectedCount}
							dedupHitRate={store.dedupHitRate}
							storageDedupRate={store.storageDedupRate}
							dedupCollapsed={store.dedupCollapsed}
							lastCheckpointId={session.lastCheckpointId}
							compressionPct={compression.session.compressionPct}
							dedupPct={compression.session.dedupPct}
						/>
					</SortableCard>
				);
			case "repo-all":
				return (
					<SortableCard id={cardId}>
						<RepoAllSessionsCard
							checkpointCount={repo.checkpointCount}
							tokensIn={compression.repo.tokensIn}
							tokensOut={compression.repo.tokensOut}
							tokensFreed={compression.repo.tokensFreed}
							sessionCount={repo.sessionCount}
							dedupCollapsed={repo.dedupCollapsed}
							storageDedupRate={repo.storageDedupRate}
							compressionPct={compression.repo.compressionPct}
							dedupPct={compression.repo.dedupPct}
						/>
					</SortableCard>
				);
			case "data-safety":
				return (
					<SortableCard id={cardId}>
						<DataSafetyCard
							regionsRetained={integrity.regionsRetained}
							compressedOriginalBytes={integrity.compressedOriginalBytes}
							duplicatesCollapsed={integrity.duplicatesCollapsed}
							bytesPermanentlyDeleted={integrity.bytesPermanentlyDeleted}
						/>
					</SortableCard>
				);
			case "config":
				return (
					<SortableCard id={cardId}>
						<ConfigSummaryCard
							tier={tier}
							presetTier={d.presetTier}
							pressure={d.pressure}
							thresholdTokens={cfg.thresholdTokens}
							tierPct={cfg.tierPct}
							contextWindow={context.contextWindow}
							fastGatePct={cfg.fastGatePct}
							auto={cfg.auto}
							anchorUserMessages={cfg.anchorUserMessages}
						/>
					</SortableCard>
				);
			case "model":
				return model ? (
					<SortableCard id={cardId} onClick={() => setOpenWidget("model")}>
						<CacheStatusPerModel
							name={model.name}
							provider={model.providerName || model.provider}
							inputRate={model.inputRate}
							outputRate={model.outputRate}
							repoTokensFreed={compression.repo.tokensFreed}
							contextWindow={context.contextWindow}
						/>
					</SortableCard>
				) : null;
			case "crew":
				return (
					<SortableCard id={cardId}>
						<SessionInfo
							activeAgents={crew.activeAgents}
							currentTurn={crew.currentTurn}
						/>
					</SortableCard>
				);
			case "cache-hits":
				return (
					<SortableCard id={cardId} onClick={() => setOpenWidget("cache")}>
						<CacheHitsCard
							cacheHitsSession={cacheHits.session}
							cacheHitsTotal={cacheHits.total}
							tokensSavedSession={cacheHits.sessionTokensSaved}
							tokensSavedTotal={cacheHits.totalTokensSaved}
							compactionsSession={compacts.session}
							compactionsTotal={compacts.total}
						/>
					</SortableCard>
				);
			case "time-saved":
				return (
					<SortableCard id={cardId} onClick={() => setOpenWidget("time")}>
						<TimeSavedCard
							compactSessionSec={timeSaved.compact.sessionSec}
							compactTotalSec={timeSaved.compact.totalSec}
							cacheHitSessionSec={timeSaved.cacheHit.sessionSec}
							cacheHitTotalSec={timeSaved.cacheHit.totalSec}
						/>
					</SortableCard>
				);
			case "rag-health":
				return NEW_UI() ? (
					<SortableCard id={cardId}>
						<RagHealthCard />
					</SortableCard>
				) : null;
			case "legend":
				return (
					<SortableCard id={cardId}>
						<LegendCard />
					</SortableCard>
				);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<Badge variant="accent">{tier}</Badge>
				<span className="text-xs text-muted-foreground">
					updated {formatUpdatedAt(updatedAt)}
				</span>
			</div>
			{/* Full-width live-context row: per-session gauges + per-repo stack
			 * sit above the grid so they get the whole width of the tab. */}
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<SessionContextGauges
					sessions={sessionsData}
					loading={sessionsLoading}
					error={sessionsErr}
					launcherSessionId={session.id}
					launcher={{
						tokens: context.tokens,
						percent: context.percent,
						contextWindow: context.contextWindow,
					}}
				/>
				<RepoContextStack
					sessions={sessionsData}
					loading={sessionsLoading}
					error={sessionsErr}
				/>
			</div>
			<DndContext onDragEnd={onDragEnd}>
				<SortableContext items={order}>
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
						{order
							.map((cardId) => ({ cardId, node: renderCard(cardId) }))
							.filter(({ node }) => node != null)
							.map(({ cardId, node }) => (
								<div key={cardId}>{node}</div>
							))}
					</div>
				</SortableContext>
			</DndContext>

			{/* ── Drill-down modals ───────────────────────────────────────── */}
			<WidgetDetailModal
				title="Cache Hits Trend"
				open={openWidget === "cache"}
				onClose={() => setOpenWidget(null)}
			>
				{perfLoading ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						Loading…
					</p>
				) : perfError ? (
					<p className="py-8 text-center text-sm text-red-400">
						{perfError.message}
					</p>
				) : (
					<PerfLineChart data={perfData} label="Cache hit %" color="#58a6ff" />
				)}
			</WidgetDetailModal>

			<WidgetDetailModal
				title="Turn Latency"
				open={openWidget === "vector"}
				onClose={() => setOpenWidget(null)}
			>
				{perfLoading ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						Loading…
					</p>
				) : perfError ? (
					<p className="py-8 text-center text-sm text-red-400">
						{perfError.message}
					</p>
				) : (
					<PerfLineChart
						data={perfData}
						label="Turn latency (ms)"
						color="#58a6ff"
					/>
				)}
			</WidgetDetailModal>

			<WidgetDetailModal
				title="Disk Write Time"
				open={openWidget === "time"}
				onClose={() => setOpenWidget(null)}
			>
				{perfLoading ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						Loading…
					</p>
				) : perfError ? (
					<p className="py-8 text-center text-sm text-red-400">
						{perfError.message}
					</p>
				) : (
					<PerfLineChart
						data={perfData}
						label="Disk write (ms)"
						color="#58a6ff"
					/>
				)}
			</WidgetDetailModal>

			<WidgetDetailModal
				title="Model &amp; Cost"
				open={openWidget === "model"}
				onClose={() => setOpenWidget(null)}
			>
				<PerfBarChart
					data={modelBarData}
					color="#3fb950"
					valueFormatter={(v) => v.toLocaleString()}
				/>
			</WidgetDetailModal>
		</div>
	);
}
