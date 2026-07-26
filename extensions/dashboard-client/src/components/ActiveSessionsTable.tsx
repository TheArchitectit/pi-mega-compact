/**
 * dashboard-client/src/components/ActiveSessionsTable.tsx — Active sessions table (S39).
 *
 * Per-session rows: PID, Repo, Model, Context %, Tokens/Window,
 * Heartbeat age, State dir, Sparkline.
 *
 * Data from /api/sessions (active sessions list) and /api/sessions/timeseries
 * (per-session data points used to render inline sparklines).
 */

import type React from "react";
import type { ActiveSession, SessionSeries } from "@contracts";

export interface ActiveSessionsTableProps {
	/** Active sessions, sorted by lastSeen descending (from /api/sessions). */
	sessions: ActiveSession[];
	/** Per-session timeseries used to render the inline sparkline column. */
	series: SessionSeries[];
}

const HEADERS = [
	"PID",
	"Repo",
	"Model",
	"Context %",
	"Tokens / Window",
	"Last Heartbeat",
	"State Dir",
	"Trend",
] as const;

/** Format a duration in milliseconds → human-readable age string. */
function fmtAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s ago`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ago`;
}

function fmtTokens(n: number | null): string {
	if (n == null) return "\u2014";
	if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return n.toLocaleString();
}

function pctClass(pct: number | null): string {
	if (pct == null) return "sessions-pct-ok";
	if (pct >= 85) return "sessions-pct-err";
	if (pct >= 60) return "sessions-pct-warn";
	return "sessions-pct-ok";
}

function fmtPct(pct: number | null): string {
	if (pct == null) return "\u2014";
	return `${Math.round(pct)}%`;
}

function fmtWindow(tokens: number | null, window: number): string {
	if (tokens == null) return "\u2014";
	return `${fmtTokens(tokens)} / ${fmtTokens(window)}`;
}

interface SparklineProps {
	/** Token counts over time (oldest → newest). */
	points: number[];
	/** Stable hex color for the stroke. */
	color: string;
}

function Sparkline({ points, color }: SparklineProps): React.ReactElement {
	if (points.length < 2) {
		return <span className="sessions-sparkline-empty">{"\u2014"}</span>;
	}
	const min = Math.min(...points);
	const max = Math.max(...points);
	const range = max - min || 1;
	const w = 64;
	const h = 18;
	const stepX = w / (points.length - 1);
	const segments = points.map((p, i) => {
		const x = i * stepX;
		const y = h - ((p - min) / range) * h;
		return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
	});
	return (
		<svg
			className="sessions-sparkline"
			width={w}
			height={h}
			viewBox={`0 0 ${w} ${h}`}
			role="img"
			aria-label="token trend"
		>
			<path
				d={segments.join(" ")}
				fill="none"
				stroke={color}
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** Map sessionId → series for the sparkline column lookup. */
function indexSeries(
	series: SessionSeries[],
): Map<string, SessionSeries> {
	const m = new Map<string, SessionSeries>();
	for (const s of series) m.set(s.sessionId, s);
	return m;
}

export function ActiveSessionsTable({
	sessions,
	series,
}: ActiveSessionsTableProps): React.ReactElement {
	const seriesById = indexSeries(series);
	const now = Date.now();

	return (
		<div className="sessions-table-scroll">
			<table className="sessions-table">
				<thead>
					<tr>
						{HEADERS.map((h, i) => (
							<th
								key={h}
								className={i >= 3 && i !== 6 ? "num" : undefined}
							>
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{sessions.length === 0 && (
						<tr className="sessions-empty-row">
							<td colSpan={HEADERS.length}>No active sessions.</td>
						</tr>
					)}
					{sessions.map((s) => {
						const srs = seriesById.get(s.sessionId);
						const sparkPts =
							srs?.data.map((d) => d.tokens) ?? [];
						const color = srs?.color ?? "#58a6ff";
						return (
							<tr key={`${s.pid}:${s.sessionId}`}>
								<td className="num">{s.pid}</td>
								<td title={s.repoRoot ?? undefined}>
									{s.displayName || s.repoRoot || "\u2014"}
								</td>
								<td>{s.model ?? "\u2014"}</td>
								<td className="num">
									<span className={`sessions-pct-pill ${pctClass(s.percent)}`}>
										{fmtPct(s.percent)}
									</span>
								</td>
								<td className="num">
									{fmtWindow(s.tokens, s.ctxWindow)}
								</td>
								<td className="num">{fmtAge(now - s.lastSeen)}</td>
								<td
									title={s.stateDir ?? undefined}
									className="sessions-meta"
								>
									{s.stateDir
										? s.stateDir.split("/").pop() || s.stateDir
										: "\u2014"}
								</td>
								<td>
									<Sparkline points={sparkPts} color={color} />
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
