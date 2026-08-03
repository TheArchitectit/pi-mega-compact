/**
 * global-sessions.ts — session heartbeats + token time-series (S39).
 *
 * Split out of global-index.ts so each file stays under 500 lines. Shares the
 * same machine-wide index DB (`indexCache` in global-index.ts) via
 * `openIndexStore()`; no schema or behavior change — pure structural move.
 *
 * `session_heartbeats`: one row per (pid, session_id) live session, upserted on
 * every material snapshot. `token_samples`: append-only rows with
 * (session_id, tokens, percent, ts) for the stacked-memory graph. Garbage-
 * collected by pruneTokenSamples.
 *
 * All queries use @named/$named bind parameters (PREVENT-002); local
 * node:sqlite + WAL (PREVENT-PI-004), multi-process safe.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { openIndexStore, getIndexDir } from "./global-index.js";

/** A live active session row (joined heartbeat + latest token sample). */
export interface ActiveSessionRow {
	pid: number;
	sessionId: string;
	repoRoot: string | null;
	stateDir: string | null;
	ctxWindow: number;
	lastSeen: number;
	tokens: number | null;
	percent: number | null;
}

/** A single time-series data point for a session. */
export interface TokenSamplePoint {
	ts: number;
	tokens: number;
	percent: number;
}

/** A recharts-ready per-session series with a stable color. */
export interface SessionSeries {
	sessionId: string;
	label: string;
	color: string;
	data: TokenSamplePoint[];
}

/** Timeseries response shape (recharts-ready). */
export interface SessionTimeseriesResult {
	series: SessionSeries[];
	totals: { ts: number; tokens: number }[];
}

/** Stable color palette for per-session series (hash-based, no randomness). */
const SESSION_COLORS = [
	"#60a5fa", // blue-400
	"#34d399", // emerald-400
	"#fbbf24", // amber-400
	"#f87171", // red-400
	"#a78bfa", // violet-400
	"#f472b6", // pink-400
	"#22d3ee", // cyan-400
	"#a3e635", // lime-400
];

/** Hash a sessionId to a stable color index. */
function sessionColor(sessionId: string): string {
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) {
		h = (h * 31 + sessionId.charCodeAt(i)) | 0;
	}
	return SESSION_COLORS[Math.abs(h) % SESSION_COLORS.length];
}

/**
 * Record (upsert) a session heartbeat. Called from snapshot() on every material
 * change. PRIMARY KEY (pid, session_id) means concurrent pi processes each get
 * their own row. Non-fatal on conflict (INSERT ... ON CONFLICT DO UPDATE).
 */
export function recordSessionHeartbeat(
	pid: number,
	sessionId: string,
	repoRoot: string,
	stateDir: string,
	ctxWindow: number,
	indexDir: string = getIndexDir(),
): void {
	const db = openIndexStore(indexDir);
	const now = Date.now();
	db.prepare(
		`INSERT INTO session_heartbeats (pid, session_id, repo_root, state_dir, ctx_window, last_seen)
     VALUES (@pid, @session_id, @repo_root, @state_dir, @ctx_window, @last_seen)
     ON CONFLICT(pid, session_id) DO UPDATE SET
       repo_root = excluded.repo_root,
       state_dir = excluded.state_dir,
       ctx_window = excluded.ctx_window,
       last_seen = excluded.last_seen`,
	).run({
		pid,
		session_id: sessionId,
		repo_root: repoRoot,
		state_dir: stateDir,
		ctx_window: ctxWindow,
		last_seen: now,
	});
	// Enforce the invariant: one heartbeat row per live pi PROCESS (pid).
	// A pi process owns exactly one session_id at a time — when it restarts /
	// resumes into a new session_id, the OLD (pid, old_session_id) row is stale
	// and must be deleted, otherwise it lingers (its last_seen was updated by
	// the prior heartbeat, so the 30-min prune won't catch it) and surfaces as
	// a phantom 0% "pi-<repo>" gauge in the dashboard's "Context per Session"
	// card (null tokens, dead session_id that no longer matches the launcher).
	// Parameterized (PREVENT-002).
	db.prepare(
		`DELETE FROM session_heartbeats WHERE pid = @pid AND session_id != @session_id`,
	).run({ pid, session_id: sessionId });
}

/**
 * Append a token sample row + optionally a session_sample line to events.log
 * (for SSE real-time push via /api/events). The eventsLogPath is optional —
 * callers without an events.log (e.g. tests) can omit it.
 */
export function appendTokenSample(
	sessionId: string,
	repoRoot: string,
	tokens: number,
	percent: number,
	ctxWindow: number,
	eventsLogPath: string | null,
	indexDir: string = getIndexDir(),
): void {
	const db = openIndexStore(indexDir);
	const now = Date.now();
	db.prepare(
		`INSERT INTO token_samples (session_id, repo_root, tokens, percent, ctx_window, ts)
     VALUES (@session_id, @repo_root, @tokens, @percent, @ctx_window, @ts)`,
	).run({
		session_id: sessionId,
		repo_root: repoRoot,
		tokens,
		percent,
		ctx_window: ctxWindow,
		ts: now,
	});
	// Step 5: also append a session_sample JSON line to events.log so the
	// existing /api/events SSE tail streams it for free (real-time chart push).
	// Mirrors the DashboardEmitter events.log append pattern in
	// extensions/mega-dashboard.ts:{ event(type, data) }: a JSON object with
	// `ts` (ISO 8601 string), `type`, and the event-specific payload. The ISO
	// timestamp matches the shape of every other SSE variant (SseSessionSample
	// contract; every SSE variant's `ts` is a string); a numeric ms `ts` would
	// violate the contract union's "every SSE variant has a ts field of type
	// string" invariant and break DashboardEmitter consumers.
	if (eventsLogPath) {
		try {
			const dir = eventsLogPath.includes("/")
				? eventsLogPath.slice(0, eventsLogPath.lastIndexOf("/"))
				: ".";
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(
				eventsLogPath,
				JSON.stringify({
					ts: new Date(now).toISOString(),
					type: "session_sample",
					sessionId,
					tokens,
					percent,
				}) + "\n",
			);
		} catch {
			/* non-fatal: SSE push is best-effort */
		}
	}
}

/**
 * Prune stale session heartbeats (sessions not seen within maxAgeMs).
 * Default 30-min retention. Called by /api/sessions.
 */
export function pruneStaleSessions(
	maxAgeMs: number = 1_800_000,
	indexDir: string = getIndexDir(),
): number {
	const db = openIndexStore(indexDir);
	const cutoff = Date.now() - maxAgeMs;
	const result = db
		.prepare("DELETE FROM session_heartbeats WHERE last_seen < @cutoff")
		.run({ cutoff });
	return Number(result.changes);
}

/**
 * Prune old token samples older than maxAgeMs. Default 30-min retention.
 * Called by /api/sessions/timeseries.
 */
export function pruneTokenSamples(
	maxAgeMs: number = 1_800_000,
	indexDir: string = getIndexDir(),
): number {
	const db = openIndexStore(indexDir);
	const cutoff = Date.now() - maxAgeMs;
	const result = db
		.prepare("DELETE FROM token_samples WHERE ts < @cutoff")
		.run({ cutoff });
	return Number(result.changes);
}

/**
 * Read all active sessions with their latest token sample (if any).
 * JOINs session_heartbeats with the latest token_samples per session_id
 * via a correlated subquery. Returns rows sorted by last_seen descending.
 */
export function readActiveSessions(
	indexDir: string = getIndexDir(),
): ActiveSessionRow[] {
	const db = openIndexStore(indexDir);
	const rows = db
		.prepare(
			`SELECT h.pid, h.session_id, h.repo_root, h.state_dir, h.ctx_window, h.last_seen,
            s.tokens, s.percent
     FROM session_heartbeats h
     LEFT JOIN token_samples s ON s.id = (
       SELECT id FROM token_samples t
       WHERE t.session_id = h.session_id
       ORDER BY t.ts DESC LIMIT 1
     )
     ORDER BY h.last_seen DESC`,
		)
		.all() as Array<{
		pid: number;
		session_id: string;
		repo_root: string | null;
		state_dir: string | null;
		ctx_window: number;
		last_seen: number;
		tokens: number | null;
		percent: number | null;
	}>;
	// Dedup BY PID (one row per live pi process, keeping the most-recently-seen
	// row). The schema PK is (pid, session_id), so a process that restarted /
	// resumed into a new session_id leaves a stale (pid, old_session_id) row
	// until recordSessionHeartbeat's cleanup fires or the 30-min prune runs.
	// Without this dedup those stale rows surface as phantom 0% gauges in the
	// "Context per Session" card (null tokens, dead session_id). Rows are
	// already ordered by last_seen DESC, so the first row seen for a pid wins.
	const seenPid = new Set<number>();
	const deduped = rows.filter((r) => {
		if (seenPid.has(r.pid)) return false;
		seenPid.add(r.pid);
		return true;
	});
	return deduped.map((r) => ({
		pid: r.pid,
		sessionId: r.session_id,
		repoRoot: r.repo_root,
		stateDir: r.state_dir,
		ctxWindow: r.ctx_window ?? 0,
		lastSeen: r.last_seen,
		tokens: r.tokens,
		percent: r.percent,
	}));
}

/**
 * Read token samples since sinceMs, returning a recharts-ready stacked shape:
 * per-session `SessionSeries` (with stable color) + a `totals` array
 * [{ts, tokens}] (sum of all sessions at each timestamp).
 */
export function readSessionTimeseries(
	sinceMs: number,
	indexDir: string = getIndexDir(),
): SessionTimeseriesResult {
	const db = openIndexStore(indexDir);
	const rows = db
		.prepare(
			`SELECT session_id, tokens, percent, ts FROM token_samples WHERE ts >= @since ORDER BY ts ASC`,
		)
		.all({ since: sinceMs }) as Array<{
		session_id: string;
		tokens: number;
		percent: number;
		ts: number;
	}>;
	// Group by session_id → series; + accumulate totals per timestamp.
	const seriesMap = new Map<string, TokenSamplePoint[]>();
	const totalsMap = new Map<number, number>();
	for (const r of rows) {
		let pts = seriesMap.get(r.session_id);
		if (!pts) {
			pts = [];
			seriesMap.set(r.session_id, pts);
		}
		pts.push({ ts: r.ts, tokens: r.tokens, percent: r.percent });
		totalsMap.set(r.ts, (totalsMap.get(r.ts) ?? 0) + r.tokens);
	}
	const series: SessionSeries[] = [];
	for (const [sessionId, data] of seriesMap) {
		const label = sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
		series.push({ sessionId, label, color: sessionColor(sessionId), data });
	}
	// Sort series by first-timestamp for stable legend order.
	series.sort((a, b) => (a.data[0]?.ts ?? 0) - (b.data[0]?.ts ?? 0));
	const totals = Array.from(totalsMap.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([ts, tokens]) => ({ ts, tokens }));
	return { series, totals };
}

/**
 * Clear a session's heartbeat row (e.g. on clean shutdown / session reset).
 * Non-fatal: no-op if the row doesn't exist.
 */
export function clearSessionHeartbeat(
	pid: number,
	sessionId: string,
	indexDir: string = getIndexDir(),
): void {
	const db = openIndexStore(indexDir);
	db.prepare(
		"DELETE FROM session_heartbeats WHERE pid = @pid AND session_id = @session_id",
	).run({ pid, session_id: sessionId });
}
