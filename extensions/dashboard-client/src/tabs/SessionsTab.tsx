/**
 * dashboard-client/src/tabs/SessionsTab.tsx — Sessions tab (S39, DASH-0b).
 *
 * DASH-0b: the Sessions surface absorbs the existent TurnsTab as a drill-down.
 * A `SessionsViews` toggle ("Active Sessions" / "Turn Memory") switches between
 * the existent sessions summary/chart/table body and the turns view (rendered by
 * `SessionsTab/TurnMemoryView.tsx` — the turns body moved VERBATIM from the
 * standalone TurnsTab.tsx, which is left untouched this sprint for flag-off
 * parity).
 *
 * Flag: `MEGACOMPACT_DASH_0B` default ON. The dashboard client is a browser
 * bundle with NO `process` global, so the positive sprint flag cannot be read
 * server-side-style (`process.env`) inside the client. Instead the flag is read
 * from the server-authoritative `/api/rag-settings` state: the server resolves
 * `process.env["MEGACOMPACT_DASH_0B"] ?? default` into the `SettingState.value`
 * boolean. When the flag is OFF (settings confirmed value=false), this surface
 * renders ONLY the existent sessions body — no toggle, no TurnMemoryView branch
 * (byte-identical predecessor). The standalone TurnsTab.tsx top-level surface is
 * untouched and remains reachable for flag-off parity.
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
import { fetchSessions, fetchSessionTimeseries, fetchSettings } from "../api/client";
import type {
	SseEvent,
	SseSessionSample,
	SessionsResponse,
	SessionTimeseriesResponse,
	SettingsResponse,
} from "@contracts";
import { SessionsMemoryChart } from "../components/SessionsMemoryChart";
import { ActiveSessionsTable } from "../components/ActiveSessionsTable";
import { Toggle } from "../components/ui/toggle";
import { Card, CardContent } from "../components/ui/card";
import { TurnMemoryView } from "./SessionsTab/TurnMemoryView";

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

const DASH_0B_KEY = "MEGACOMPACT_DASH_0B";

/** Resolve the DASH-0b consolidation flag from the server settings state.
 *  Absent/not-yet-loaded => false (flag-off posture), so flag-off users never
 *  see a toggle flash; the toggle appears only once settings confirm it is ON. */
function dash0bEnabled(settings: SettingsResponse | null): boolean {
	if (!settings) return false;
	for (const cat of settings.categories) {
		for (const s of cat.settings) {
			if (s.key === DASH_0B_KEY && s.type === "boolean") return s.value === true;
		}
	}
	return false;
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
		<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
			<Card>
				<CardContent>
					<span className="text-xs text-muted-foreground">Active sessions</span>
					<div className="text-xl font-semibold">{active}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent>
					<span className="text-xs text-muted-foreground">Combined tokens</span>
					<div className="text-xl font-semibold">
						{combinedTokens >= 100_000
							? `${(combinedTokens / 1000).toFixed(0)}k`
							: combinedTokens.toLocaleString()}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent>
					<span className="text-xs text-muted-foreground">
						Combined % of max window
					</span>
					<div className="text-xl font-semibold">{Math.round(combinedPct)}%</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent>
					<span className="text-xs text-muted-foreground">Pruned (stale)</span>
					<div className="text-xl font-semibold">{sessions.pruned}</div>
				</CardContent>
			</Card>
		</div>
	);
}

type SessionsView = "active" | "turns";

export default function SessionsTab(): React.ReactElement {
	const [minutes, setMinutes] = useState(30);
	const [view, setView] = useState<SessionsView>("active");

	const {
		data: settingsData,
	} = useApi<SettingsResponse>(
		useCallback(() => fetchSettings(), []),
		{ pollInterval: 0, maxRetries: 0 },
	);
	const dash0bOn = dash0bEnabled(settingsData);

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

	if (dash0bOn && view === "turns") {
		return <TurnMemoryView />;
	}

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
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h2 className="font-heading text-lg font-semibold">
					Session Memory Graph
				</h2>
				<div className="flex gap-2">
					{WINDOWS.map((w) => (
						<Toggle
							key={w.value}
							pressed={minutes === w.value}
							onClick={() => setMinutes(w.value)}
						>
							{w.label}
						</Toggle>
					))}
				</div>
			</div>

			{dash0bOn && (
				<div
					className="flex items-center gap-2"
					role="tablist"
					aria-label="Sessions views"
				>
					<Toggle
						pressed={view === "active"}
						onClick={() => setView("active")}
					>
						Active Sessions
					</Toggle>
					<Toggle
						pressed={view === "turns"}
						onClick={() => setView("turns")}
					>
						Turn Memory
					</Toggle>
				</div>
			)}

			{sessions.length === 0 ? (
				<div className="text-sm text-muted-foreground">No active sessions.</div>
			) : (
				<>
					<SummaryTiles sessions={sessionsData} />
					<SessionsMemoryChart series={series} totals={totals} />
					<h2 className="font-heading text-lg font-semibold">
						Active Sessions
					</h2>
					<ActiveSessionsTable sessions={sessions} series={series} />
					<div className="text-xs text-muted-foreground">
						{series.length} series · {totals.length} timestamps ·{" "}
						{windowLabel} window · updated{" "}
						{timeseriesData?.updatedAt ?? sessionsData.updatedAt}
					</div>
				</>
			)}
		</div>
	);
}
