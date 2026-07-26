/**
 * dashboard-client/src/components/RepoContextStack.tsx — Stacked per-repo context bar (S40).
 *
 * Horizontal stacked bar: one colored segment per active repo, aggregating
 * that repo's active sessions' token counts. Renders a combined total line
 * and a legend mapping each repo (basename of repoRoot) to its segment color
 * + token count + % of total.
 *
 * Stable per-repo colors: the repoRoot basename is hashed to a deterministic
 * index into a fixed palette array, so the same repo always gets the same
 * color across renders/tabs (mirrors SessionsMemoryChart's stable-color
 * contract from S39).
 *
 * PREVENT-PI-004: this is a pure presentational component — no fetch, no
 * network. Data is passed in by the parent (OverviewTab) via
 * useApi(fetchSessions) + useSSE() for real-time updates.
 */

import type React from "react";
import type { ActiveSession, SessionsResponse } from "@contracts";

export interface RepoContextStackProps {
	/** Active sessions from /api/sessions (may be null while loading). */
	sessions: SessionsResponse | null;
	/** Whether the initial fetch is in flight. */
	loading: boolean;
	/** Fetch error, if any. */
	error: Error | null;
}

// ─── Stable color palette ─────────────────────────────────────────────────────
// Fixed set of hex colors used for stable per-repo coloring. The hash function
// maps a repoRoot basename to a deterministic palette index so the same repo
// always renders the same color.
const REPO_PALETTE: ReadonlyArray<string> = [
	"#58a6ff", // blue
	"#3fb950", // green
	"#d29922", // yellow
	"#f85149", // red
	"#bc8cff", // purple
	"#ff7b72", // salmon
	"#79c0ff", // light blue
	"#56d4dd", // cyan
	"#e3b341", // gold
	"#a5d6ff", // pale blue
	"#7ee787", // mint
	"#ffa657", // orange
];

/**
 * Simple deterministic string hash (djb2 variant). Returns a non-negative
 * 32-bit integer.
 */
function hashString(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/**
 * Pick a stable color for a repoRoot basename. Falls back to "(unknown)" if
 * the basename is empty.
 */
function colorForRepo(basename: string): string {
	if (!basename) return REPO_PALETTE[0];
	return REPO_PALETTE[hashString(basename) % REPO_PALETTE.length];
}

/**
 * Extract the basename from a repoRoot path. Uses `"/"` as the universal
 * separator on all OSes (repoRoot is an absolute path from the dashboard
 * server; on Windows pi actually uses forward-slash normalized paths anyway).
 */
function repoBasename(repoRoot: string | null): string {
	if (!repoRoot) return "(unknown)";
	const trimmed = repoRoot.replace(/[\\/]+$/, "");
	if (!trimmed) return "(unknown)";
	const parts = trimmed.split(/[\\/]/);
	const last = parts[parts.length - 1];
	return last || trimmed;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface RepoAggregate {
	repoRoot: string | null;
	basename: string;
	tokens: number;
	color: string;
}

function aggregateRepos(sessions: ReadonlyArray<ActiveSession>): {
	repos: RepoAggregate[];
	totalTokens: number;
	maxWindow: number;
	sessionCount: number;
} {
	const map = new Map<string, RepoAggregate>();
	for (const s of sessions) {
		const key = s.repoRoot ?? "__null__";
		const tokens = s.tokens ?? 0;
		const existing = map.get(key);
		if (existing) {
			existing.tokens += tokens;
		} else {
			const basename = repoBasename(s.repoRoot);
			map.set(key, {
				repoRoot: s.repoRoot,
				basename,
				tokens,
				color: colorForRepo(basename),
			});
		}
	}
	const repos = [...map.values()];
	const totalTokens = repos.reduce((sum, r) => sum + r.tokens, 0);
	// Combined max window: the largest ctxWindow among the active sessions.
	// This mirrors SessionsTab's SummaryTiles combined-% logic.
	const maxWindow = sessions.reduce(
		(max, s) => Math.max(max, s.ctxWindow),
		0,
	);
	return {
		repos,
		totalTokens,
		maxWindow,
		sessionCount: sessions.length,
	};
}

function fmtTokens(n: number): string {
	if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
	return n.toLocaleString();
}

export function RepoContextStack({
	sessions,
	loading,
	error,
}: RepoContextStackProps): React.ReactElement | null {
	if (error) {
		return (
			<div className="card repo-stack-card">
				<h3>Context per Repo (live)</h3>
				<div className="sessions-empty">
					Error loading sessions: {error.message}
				</div>
			</div>
		);
	}

	if (loading && !sessions) {
		return (
			<div className="card repo-stack-card">
				<h3>Context per Repo (live)</h3>
				<div className="sessions-empty">Loading sessions…</div>
			</div>
		);
	}

	const activeSessions = sessions?.sessions ?? [];
	const { repos, totalTokens, maxWindow, sessionCount } =
		aggregateRepos(activeSessions);

	if (repos.length === 0) {
		return (
			<div className="card repo-stack-card">
				<h3>Context per Repo (live)</h3>
				<div className="sessions-empty">No active sessions.</div>
			</div>
		);
	}

	const combinedPct =
		maxWindow > 0 ? Math.round((totalTokens / maxWindow) * 100) : 0;

	return (
		<div className="card repo-stack-card">
			<h3>Context per Repo (live)</h3>
			<div
				className="repo-stack-bar"
				role="group"
				aria-label="Per-repo context usage"
			>
				{repos.map((r) => {
					const pctOfTotal =
						totalTokens > 0 ? (r.tokens / totalTokens) * 100 : 0;
					const widthPct = totalTokens > 0 ? pctOfTotal : 0;
					const tooltip =
						`${r.basename}: ${fmtTokens(r.tokens)} tokens ` +
						`(${pctOfTotal.toFixed(1)}% of total)`;
					return (
						<div
							key={r.repoRoot ?? "__null__"}
							className="repo-stack-segment"
							style={{
								width: `${Math.max(widthPct, 0.5)}%`,
								backgroundColor: r.color,
							}}
							title={tooltip}
							aria-label={tooltip}
						/>
					);
				})}
			</div>
			<p className="repo-stack-total">
				{fmtTokens(totalTokens)} tokens across {repos.length}{" "}
				{repos.length === 1 ? "repo" : "repos"} /{" "}
				{sessionCount}{" "}
				{sessionCount === 1 ? "session" : "sessions"}{" "}
				<span className="pct">— {combinedPct}% of combined max window</span>
			</p>
			<div className="repo-stack-legend">
				{repos.map((r) => {
					const pctOfTotal =
						totalTokens > 0 ? (r.tokens / totalTokens) * 100 : 0;
					return (
						<div
							key={r.repoRoot ?? "__null__"}
							className="repo-stack-legend-item"
						>
							<span
								className="repo-stack-legend-swatch"
								style={{ backgroundColor: r.color }}
							/>
							<span className="repo-stack-legend-name">{r.basename}</span>
							<span>
								{fmtTokens(r.tokens)} ({pctOfTotal.toFixed(0)}%)
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
