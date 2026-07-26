/**
 * dashboard-client/src/tabs/SessionsTab.tsx — Sessions tab (S39).
 *
 * Renders: window selector (5/15/30/60 min), sessions summary tiles,
 * the stacked-memory graph (SessionsMemoryChart), and the active sessions
 * table (ActiveSessionsTable).
 *
 * Data sources: fetchSessions() + fetchSessionTimeseries(minutes). Both poll
 * every 2s for near-real-time updates. useSSE() listens for session_sample
 * events emitted by appendTokenSample (Step 5) so the chart refetches
 * instantly between polls when a new token sample is appended to events.log.
 *
 * Empty state: shows "No active sessions." when the /api/sessions response
 * returns an empty array (e.g. no pi processes are running yet).
 */

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import { fetchSessions, fetchSessionTimeseries } from "../api/client";
import type { SseEvent, SseSessionSample, SessionsResponse, SessionTimeseriesResponse } from "@contracts";
import { SessionsMemoryChart } from "../components/SessionsMemoryChart";
import { ActiveSessionsTable } from "../components/ActiveSessionsTable";

/**
 * Shape of the {@link SseSessionSample} SSE event appended to events.log by
 * `appendTokenSample` (src/store/sqlite/global-index.ts). The contract now
 * defines this variant as part of the {@link SseEvent} union (Step 5); the
 * local alias keeps the surface terser in this file.
 */
type SessionSampleEvent = SseSessionSample;

/** Type guard: narrows an SSE event to a session_sample event. */
function isSessionSample(
	e: SseEvent,
): e is SessionSampleEvent {
	return e.type === "session_sample";
}

const WINDOWS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 5, label: "5m" },
	{ value: 15, label: "15m" },
	{ value: 30, label: "30m" },
	{ value: 60, label: "60m" },
] as const;

interface SummaryTilesProps {
	sessions: SessionsResponse;
}

function SummaryTiles({ sessions }: SummaryTilesProps): React.ReactElement {
	const active = sessions.sessions.length;
	const combinedTokens = sessions.sessions.reduce(
		(sum, s) => sum + (s.tokens ?? 0),
		0,
	);
	const maxWindow = sessions.sessions.reduce(
		(max, s) => Math.max(max, s.ctxWindow),
		0,
	);
	const combinedPct = maxWindow > 0 ? (combinedTokens / maxWindow) * 100 : 0;
	return (
		<div className="sessions-summary-tiles">
			<div className="tile">
				<span className="tile-label">Active sessions</span>
				<span className="tile-value">{active}</span>
			</div>
			<div className="tile">
				<span className="tile-label">Combined tokens</span>
				<span className="tile-value">
					{combinedTokens >= 100_000
						? `${(combinedTokens / 1000).toFixed(0)}k`
						: combinedTokens.toLocaleString()}
				</span>
			</div>
			<div className="tile">
				<span className="tile-label">Combined % of max window</span>
				<span className="tile-value">{Math.round(combinedPct)}%</span>
			</div>
			<div className="tile">
				<span className="tile-label">Pruned (stale)</span>
				<span className="tile-value">{sessions.pruned}</span>
			</div>
		</div>
	);
}

export default function SessionsTab(): React.ReactElement {
	const [minutes, setMinutes] = useState(30);

	const {
		data: sessionsData,
		error: sessionsErr,
		refetch: refetchSessions,
	} = useApi<SessionsResponse>(
		useCallback(() => fetchSessions(), []),
		{ pollInterval: 2_000 },
	);

	const {
		data: timeseriesData,
		error: timeseriesErr,
		refetch: refetchTimeseries,
	} = useApi<SessionTimeseriesResponse>(
		useCallback(() => fetchSessionTimeseries(minutes), [minutes]),
		{ pollInterval: 2_000 },
	);

	const { events } = useSSE();

	// Filter SSE events for session_sample pushes (Step 5) and trigger an
	// immediate refetch when a new sample arrives, so the chart updates
	// between the 2s polls. The events array grows as new samples arrive; the
	// length-based dependency means the effect re-runs when a new sample event
	// lands (not on every poll). We debounce via a microtask guard.
	const sampleEvents = useMemo(
		() => events.filter(isSessionSample),
		[events],
	);

	const lastSampleTs = useMemo(() => {
		if (sampleEvents.length === 0) return null;
		return sampleEvents[sampleEvents.length - 1].ts;
	}, [sampleEvents]);

	useEffect(() => {
		if (lastSampleTs == null) return;
		refetchSessions();
		refetchTimeseries();
	}, [lastSampleTs, refetchSessions, refetchTimeseries]);

	if (sessionsErr && !sessionsData) {
		return (
			<div className="tab-stub">
				Error loading sessions: {sessionsErr.message}
			</div>
		);
	}
	if (timeseriesErr && !timeseriesData) {
		return (
			<div className="tab-stub">
				Error loading timeseries: {timeseriesErr.message}
			</div>
		);
	}
	if (!sessionsData) {
		return <div className="tab-stub">Loading sessions…</div>;
	}

	const sessions = sessionsData.sessions;
	const series = timeseriesData?.series ?? [];
	const totals = timeseriesData?.totals ?? [];
	const windowLabel =
		WINDOWS.find((w) => w.value === minutes)?.label ?? `${minutes}m`;

	return (
		<div className="sessions-tab">
			<div className="sessions-toolbar">
				<h2>Session Memory Graph</h2>
				<div className="sessions-window-select">
					{WINDOWS.map((w) => (
						<button
							key={w.value}
							type="button"
							className={`sessions-window-btn ${minutes === w.value ? "active" : ""}`}
							onClick={() => setMinutes(w.value)}
							aria-pressed={minutes === w.value}
						>
							{w.label}
						</button>
					))}
				</div>
			</div>

			{sessions.length === 0 ? (
				<div className="sessions-empty">No active sessions.</div>
			) : (
				<>
					<SummaryTiles sessions={sessionsData} />
					<SessionsMemoryChart series={series} totals={totals} />
					<h2 className="section-header">Active Sessions</h2>
					<ActiveSessionsTable sessions={sessions} series={series} />
					<div className="sessions-footer">
						{series.length} series · {totals.length} timestamps ·{" "}
						{windowLabel} window · updated{" "}
						{timeseriesData?.updatedAt ?? sessionsData.updatedAt}
					</div>
				</>
			)}
		</div>
	);
}
