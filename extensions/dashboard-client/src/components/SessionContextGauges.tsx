/**
 * dashboard-client/src/components/SessionContextGauges.tsx — Per-session context gauges (S40).
 *
 * Replaces the single launcher-only ContextGauge on the Overview tab with a
 * wrapping grid of compact gauges, one per active pi session. The launcher's
 * own session is always shown first + highlighted ("this session"), sourced
 * from the live snapshot (always available, never depends on heartbeat
 * timing). Other active sessions come from /api/sessions, sorted by lastSeen
 * descending, each labeled with repo basename + PID.
 *
 * Reuses the existing .gauge-bar / .gauge-fill / .gauge-{green,yellow,red}
 * classes from overview-events.css so the fill bars match the original
 * ContextGauge styling.
 *
 * PREVENT-PI-004: pure presentational component — no fetch, no network. Data
 * is passed in by the parent (OverviewTab) via its useApi(fetchSessions) +
 * useSSE() for real-time updates.
 */

import type React from "react";
import type { ActiveSession, SessionsResponse } from "@contracts";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";

export interface SessionContextGaugesProps {
	/** Active sessions from /api/sessions (may be null while loading). */
	sessions: SessionsResponse | null;
	/** Whether the initial fetch is in flight. */
	loading: boolean;
	/** Fetch error, if any. */
	error: Error | null;
	/** Launcher's own session ID (from snapshot.session.id), to exclude it
	 * from the "other sessions" list (it's always rendered separately). */
	launcherSessionId: string | null;
	/** Launcher's own context values (from snapshot — always available). */
	launcher: {
		tokens: number | null;
		percent: number | null;
		contextWindow: number;
	};
}

function severityClass(percent: number): string {
	if (percent >= 90) return "gauge-red";
	if (percent >= 70) return "gauge-yellow";
	return "gauge-green";
}

function fmtTokens(n: number | null): string {
	if (n == null) return "?";
	if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
	return n.toLocaleString();
}

function repoBasename(repoRoot: string | null): string {
	if (!repoRoot) return "(unknown)";
	const trimmed = repoRoot.replace(/[\\/]+$/, "");
	if (!trimmed) return "(unknown)";
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || trimmed;
}

function fmtAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ago`;
}

interface GaugeData {
	key: string;
	label: string;
	sublabel: string;
	tokens: number | null;
	percent: number | null;
	contextWindow: number;
	isSelf: boolean;
}

/** A single readable gauge: header label, fill bar, tokens/window sublabel. */
function SessionGauge({ data }: { data: GaugeData }): React.ReactElement {
	const pct = data.percent ?? 0;
	const fillWidth = Math.max(pct, 1);
	const cls = severityClass(pct);
	const tokStr = fmtTokens(data.tokens);
	const windowStr = data.contextWindow.toLocaleString();
	const sublabel = `${tokStr} / ${windowStr} tokens`;
	return (
		<div className={`session-gauge ${data.isSelf ? "session-gauge-self" : ""}`}>
			<div className="session-gauge-head">
				{/* Full repo/session name by default; truncate only as a last
				 * resort (ellipsis + hover title) when space is genuinely tight. */}
				<span className="session-gauge-label truncate" title={data.label}>
					{data.label}
				</span>
				<span className="session-gauge-pct">{pct}%</span>
			</div>
			<div
				className={`gauge-bar ${cls}`}
				role="meter"
				aria-valuenow={pct}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`${data.label}: ${pct}%`}
			>
				<div className="gauge-fill" style={{ width: `${fillWidth}%` }} />
			</div>
			<p className="gauge-label session-gauge-sub">{sublabel}</p>
			{data.sublabel && (
				<p className="session-gauge-meta truncate" title={data.sublabel}>
					{data.sublabel}
				</p>
			)}
		</div>
	);
}

export function SessionContextGauges({
	sessions,
	loading,
	error,
	launcherSessionId,
	launcher,
}: SessionContextGaugesProps): React.ReactElement {
	const now = Date.now();

	// Launcher gauge (always rendered, sourced from the snapshot). Include a
	// truncated session ID so the user can tell WHICH session this is when
	// multiple sessions are open.
	const selfId = launcherSessionId
		? launcherSessionId.length > 12
			? `${launcherSessionId.slice(0, 8)}…`
			: launcherSessionId
		: null;
	const gauges: GaugeData[] = [
		{
			key: "self",
			label: selfId ? `this session (${selfId})` : "this session",
			sublabel: launcherSessionId ?? "",
			tokens: launcher.tokens,
			percent: launcher.percent,
			contextWindow: launcher.contextWindow,
			isSelf: true,
		},
	];

	// Other active sessions (exclude the launcher by sessionId to avoid dup).
	// Dedup BY REPO (not just pid): two different pi processes can share the
	// same session_id (e.g. a resumed session across restarts leaves stale
	// heartbeat rows under different pids), and multiple distinct sessions can
	// run in the same repo. Either way the user wants ONE gauge per repo
	// (the most-recently-seen), not a fan-out of stale rows. Rows are sorted
	// by lastSeen DESC below before the loop so the first row seen for a repo
	// wins.
	const othersRaw: ActiveSession[] = (sessions?.sessions ?? []).filter(
		(s) => s.sessionId !== launcherSessionId,
	);
	othersRaw.sort((a, b) => b.lastSeen - a.lastSeen);
	const seenRepo = new Set<string>();
	const others: ActiveSession[] = othersRaw.filter((s) => {
		// Skip stale rows with no token sample — they have nothing to gauge
		// and are always either a fresh session (briefly) or a dead lingering
		// row. Either way a 0% / "?" gauge is noise.
		if (s.tokens == null && s.percent == null) return false;
		// Also skip rows where percent is 0 but tokens are present — these are
		// stale heartbeats whose token_samples join returned a 0 percent
		// (a transient state during session startup). A 0% gauge is noise.
		if (
			s.percent != null &&
			s.percent === 0 &&
			s.tokens != null &&
			s.tokens > 0
		)
			return false;
		const repoKey = s.repoRoot ?? `(pid:${s.pid})`;
		if (seenRepo.has(repoKey)) return false;
		seenRepo.add(repoKey);
		return true;
	});
	for (const s of others) {
		gauges.push({
			key: s.sessionId,
			label: repoBasename(s.repoRoot),
			sublabel: `pid ${s.pid} · ${fmtAge(now - s.lastSeen)}${
				s.model ? ` · ${s.model}` : ""
			}`,
			tokens: s.tokens,
			percent: s.percent,
			contextWindow: s.ctxWindow || 0,
			isSelf: false,
		});
	}

	const hasError = error && !sessions;
	const showLoading = loading && !sessions;

	return (
		<Card className="electric-hover session-gauges-card w-full">
			<CardHeader>
				<CardTitle>Context per Session (live)</CardTitle>
			</CardHeader>
			<CardContent>
				{hasError ? (
					<div className="text-sm text-muted-foreground">
						Error loading sessions: {error!.message}
					</div>
				) : showLoading ? (
					<div className="text-sm text-muted-foreground">Loading sessions…</div>
				) : (
					<div className="session-gauges-scroll">
						<div className="session-gauges-grid">
							{gauges.map((g) => (
								<SessionGauge key={g.key} data={g} />
							))}
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
