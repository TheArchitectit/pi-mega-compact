/**
 * global-index.ts — machine-wide index DB (repo registry + injected-set).
 *
 * A single SQLite DB, separate from every per-repo store, that aggregates one
 * row per repo this machine has run on. The multi-repo dashboard (Summary /
 * All-repos tabs) reads it so ONE dashboard can show every repo's checkpoints,
 * tokens saved, and active model — instead of a per-repo dashboard that only
 * ever sees the repo it was launched from.
 *
 * Written by every pi process on repo-switch (bindRepo) + model capture; read by
 * the dashboard server. Concurrency across 10+ pi processes is handled by WAL +
 * infrequent idempotent upserts (ON CONFLICT). Fully local (PREVENT-PI-004).
 */
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Resolve the machine-wide index directory (env-overridable). */
export function getIndexDir(): string {
  const override = process.env.MEGACOMPACT_INDEX_DIR;
  if (override && override.trim() !== "") return override;
  // homedir() can throw in exotic sandboxes; fall back to tmpdir.
  try {
    return join(homedir(), ".mega-compact-index");
  } catch {
    return join(tmpdir(), ".mega-compact-index");
  }
}

let indexCache: DatabaseSync | undefined;
let indexCacheDir: string | undefined;

/** Open (or reuse) the machine-wide index DB. WAL for concurrent writers. */
export function openIndexStore(indexDir: string = getIndexDir()): DatabaseSync {
  if (indexCache && indexCacheDir === indexDir) return indexCache;
  if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
  const iddb = new DatabaseSync(join(indexDir, "index.sqlite"));
  iddb.exec("PRAGMA journal_mode = WAL");
  iddb.exec("PRAGMA busy_timeout = 3000"); // tolerate brief cross-process write contention
  iddb.exec(`
    CREATE TABLE IF NOT EXISTS repo_registry (
      repo_root                 TEXT PRIMARY KEY,
      display_name              TEXT,
      state_dir                 TEXT NOT NULL,
      first_seen                INTEGER,
      last_seen                 INTEGER,
      last_compacted_at         INTEGER,
      checkpoint_count          INTEGER DEFAULT 0,
      tokens_saved              INTEGER DEFAULT 0,
      compressed_original_bytes INTEGER DEFAULT 0,
      provider                  TEXT,
      provider_name             TEXT,
      model_name                TEXT,
      input_rate                REAL,
      output_rate               REAL,
      model_captured_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_registry_last_seen ON repo_registry(last_seen DESC);
    -- S18: machine-wide injected-set. A foreign checkpoint injected in repo A is
    -- recorded here so repo B's recall never re-injects it. Keyed by checkpoint
    -- + session (a checkpoint may be injected once per session); repo_id is the
    -- source repo (the foreign repo's stateDir) for tracking/source labels.
    -- PRAMETERIZED queries (PREVENT-002); local node:sqlite (PREVENT-PI-004).
    CREATE TABLE IF NOT EXISTS injected_global (
      checkpoint_id TEXT NOT NULL,
      repo_id       TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      injected_at   INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_injected_global_cid ON injected_global(checkpoint_id);
    -- S39: machine-wide session heartbeats + token time-series for the live
    -- multi-pi stacked-memory graph. One row per (pid, session_id), updated
    -- on every material snapshot() change (NOT on idle/context-repeat events).
    -- Written by every pi process; read by the dashboard server. WAL-safe.
    -- PRAMETERIZED queries (PREVENT-002); local node:sqlite (PREVENT-PI-004).
    CREATE TABLE IF NOT EXISTS session_heartbeats (
      pid          INTEGER NOT NULL,
      session_id   TEXT NOT NULL,
      repo_root    TEXT,
      state_dir    TEXT,
      ctx_window   INTEGER DEFAULT 0,
      last_seen    INTEGER NOT NULL,
      PRIMARY KEY (pid, session_id)
    );
    CREATE TABLE IF NOT EXISTS token_samples (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      repo_root    TEXT,
      tokens       INTEGER NOT NULL,
      percent      REAL NOT NULL,
      ctx_window   INTEGER DEFAULT 0,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_samples_ts ON token_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_token_samples_sid_ts ON token_samples(session_id, ts);
  `);
  indexCache = iddb;
  indexCacheDir = indexDir;
  return iddb;
}

/** One row of the global repo registry (multi-repo dashboard source). */
export interface RepoRegistryRow {
  repoRoot: string;
  displayName: string;
  stateDir: string;
  firstSeen: number;
  lastSeen: number;
  lastCompactedAt: number | null;
  checkpointCount: number;
  tokensSaved: number;
  compressedOriginalBytes: number;
  provider: string | null;
  providerName: string | null;
  modelName: string | null;
  inputRate: number | null;
  outputRate: number | null;
  modelCapturedAt: number | null;
}

/**
 * Upsert a repo's aggregate stats into the global index. Called on repo-switch
 * (infrequent). Preserves first_seen + the model columns on update (model is
 * written separately by recordRepoModel so we never clobber it here with nulls).
 */
export function upsertRepoRegistry(
  row: {
    repoRoot: string;
    displayName: string;
    stateDir: string;
    checkpointCount: number;
    tokensSaved: number;
    compressedOriginalBytes: number;
    lastCompactedAt?: number | null;
    // The fields below are optional passthroughs so test fixtures and the
    // /api/repos active-window filter can seed them directly. They're also
    // written by other paths (recordRepoModel, registry refresh) — passing
    // them here is harmless because the ON CONFLICT clause keeps first_seen
    // and the model columns from being clobbered.
    firstSeen?: number;
    lastSeen?: number;
    provider?: string | null;
    providerName?: string | null;
    modelName?: string | null;
    inputRate?: number | null;
    outputRate?: number | null;
    modelCapturedAt?: number | null;
  },
  indexDir: string = getIndexDir(),
): void {
  const db = openIndexStore(indexDir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO repo_registry
       (repo_root, display_name, state_dir, first_seen, last_seen, last_compacted_at,
        checkpoint_count, tokens_saved, compressed_original_bytes,
        provider, provider_name, model_name, input_rate, output_rate, model_captured_at)
     VALUES (@repo_root, @display_name, @state_dir, @first_seen, @last_seen, @last_compacted_at,
             @checkpoint_count, @tokens_saved, @compressed_original_bytes,
             @provider, @provider_name, @model_name, @input_rate, @output_rate, @model_captured_at)
     ON CONFLICT(repo_root) DO UPDATE SET
       display_name = excluded.display_name,
       state_dir = excluded.state_dir,
       last_seen = COALESCE(excluded.last_seen, @now),
       last_compacted_at = COALESCE(excluded.last_compacted_at, repo_registry.last_compacted_at),
       checkpoint_count = excluded.checkpoint_count,
       tokens_saved = excluded.tokens_saved,
       compressed_original_bytes = excluded.compressed_original_bytes,
       provider = COALESCE(excluded.provider, repo_registry.provider),
       provider_name = COALESCE(excluded.provider_name, repo_registry.provider_name),
       model_name = COALESCE(excluded.model_name, repo_registry.model_name),
       input_rate = COALESCE(excluded.input_rate, repo_registry.input_rate),
       output_rate = COALESCE(excluded.output_rate, repo_registry.output_rate),
       model_captured_at = COALESCE(excluded.model_captured_at, repo_registry.model_captured_at)`,
  ).run({
    repo_root: row.repoRoot,
    display_name: row.displayName,
    state_dir: row.stateDir,
    now,
    first_seen: row.firstSeen ?? null,
    last_seen: row.lastSeen ?? null,
    last_compacted_at: row.lastCompactedAt ?? null,
    checkpoint_count: row.checkpointCount,
    tokens_saved: row.tokensSaved,
    compressed_original_bytes: row.compressedOriginalBytes,
    provider: row.provider ?? null,
    provider_name: row.providerName ?? null,
    model_name: row.modelName ?? null,
    input_rate: row.inputRate ?? null,
    output_rate: row.outputRate ?? null,
    model_captured_at: row.modelCapturedAt ?? null,
  });
}

/**
 * Record the active model/provider for a repo in the global index (denormalized
 * so the All-repos table shows model without opening each repo's DB). Upserts a
 * bare registry row if the repo isn't registered yet.
 */
export function recordRepoModel(
  repoRoot: string,
  model: {
    provider: string;
    providerName: string | null;
    modelName: string | null;
    inputRate: number;
    outputRate: number;
    stateDir: string;
    displayName: string;
  },
  indexDir: string = getIndexDir(),
): void {
  const db = openIndexStore(indexDir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO repo_registry
       (repo_root, display_name, state_dir, first_seen, last_seen,
        provider, provider_name, model_name, input_rate, output_rate, model_captured_at)
     VALUES (@repo_root, @display_name, @state_dir, @now, @now,
             @provider, @provider_name, @model_name, @input_rate, @output_rate, @now)
     ON CONFLICT(repo_root) DO UPDATE SET
       last_seen = excluded.last_seen,
       provider = excluded.provider,
       provider_name = excluded.provider_name,
       model_name = excluded.model_name,
       input_rate = excluded.input_rate,
       output_rate = excluded.output_rate,
       model_captured_at = excluded.model_captured_at`,
  ).run({
    repo_root: repoRoot,
    display_name: model.displayName,
    state_dir: model.stateDir,
    now,
    provider: model.provider,
    provider_name: model.providerName,
    model_name: model.modelName,
    input_rate: model.inputRate,
    output_rate: model.outputRate,
  });
}

function mapRegistryRow(row: any): RepoRegistryRow {
  return {
    repoRoot: row.repo_root,
    displayName: row.display_name ?? "",
    stateDir: row.state_dir,
    firstSeen: row.first_seen ?? 0,
    lastSeen: row.last_seen ?? 0,
    lastCompactedAt: row.last_compacted_at ?? null,
    checkpointCount: row.checkpoint_count ?? 0,
    tokensSaved: row.tokens_saved ?? 0,
    compressedOriginalBytes: row.compressed_original_bytes ?? 0,
    provider: row.provider ?? null,
    providerName: row.provider_name ?? null,
    modelName: row.model_name ?? null,
    inputRate: row.input_rate ?? null,
    outputRate: row.output_rate ?? null,
    modelCapturedAt: row.model_captured_at ?? null,
  };
}

/** All registered repos, most-recently-seen first. */
export function listRepoRegistry(indexDir: string = getIndexDir()): RepoRegistryRow[] {
  const db = openIndexStore(indexDir);
  const rows = db.prepare("SELECT * FROM repo_registry ORDER BY last_seen DESC").all() as any[];
  return rows.map(mapRegistryRow);
}

/** A single repo's registry row, or undefined. */
export function getRepoRegistry(repoRoot: string, indexDir: string = getIndexDir()): RepoRegistryRow | undefined {
  const db = openIndexStore(indexDir);
  const row = db.prepare("SELECT * FROM repo_registry WHERE repo_root = ?").get(repoRoot) as any;
  return row ? mapRegistryRow(row) : undefined;
}

/** Close the cached index connection (test teardown only). */
export function closeIndexStore(): void {
  if (indexCache) {
    indexCache.close();
    indexCache = undefined;
    indexCacheDir = undefined;
  }
}

// ---------------------------------------------------------------------------
// S18: machine-wide injected-set (cross-repo dedup markers)
//
// A foreign checkpoint injected in repo A is recorded here so repo B's recall
// never re-injects it (a stronger, machine-wide version of the per-session
// injected-set in the local store). Keyed by (checkpoint_id, session_id); the
// session_id here is the RECEIVING session, so the same foreign checkpoint can
// be injected into different sessions but never twice into the same one.
// PRAMETERIZED queries (PREVENT-002); local node:sqlite + WAL (PREVENT-PI-004),
// multi-process safe.
// ---------------------------------------------------------------------------

/** Record that a (foreign) checkpoint was injected into `sessionId`. Idempotent. */
export function markInjectedGlobal(
  checkpointId: string,
  repoId: string,
  sessionId: string,
  indexDir: string = getIndexDir(),
): void {
  const db = openIndexStore(indexDir);
  db.prepare(
    "INSERT OR IGNORE INTO injected_global (checkpoint_id, repo_id, session_id, injected_at) VALUES ($cid, $rid, $sid, $ts)",
  ).run({ $cid: checkpointId, $rid: repoId, $sid: sessionId, $ts: Date.now() });
}

/** True when a checkpoint was already injected into `sessionId` (machine-wide). */
export function wasInjectedGlobal(
  checkpointId: string,
  sessionId: string,
  indexDir: string = getIndexDir(),
): boolean {
  const db = openIndexStore(indexDir);
  const row = db.prepare(
    "SELECT 1 FROM injected_global WHERE checkpoint_id = $cid AND session_id = $sid LIMIT 1",
  ).get({ $cid: checkpointId, $sid: sessionId }) as { "1": number } | undefined;
  return row !== undefined;
}

/** Count of cross-repo injections recorded (for /mega-status stats). */
export function countInjectedGlobal(indexDir: string = getIndexDir()): number {
  const db = openIndexStore(indexDir);
  const row = db.prepare("SELECT COUNT(*) AS n FROM injected_global").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// S39: session heartbeats + token time-series (multi-pi stacked memory graph)
//
// `session_heartbeats`: one row per (pid, session_id), upserted on every
// material snapshot() change. This is the reliable liveness signal the
// dashboard /api/sessions endpoint reads (repo_registry.last_seen only updates
// on repo-switch / bindRepo, so a long-running single-repo process looks
// inactive; these heartbeats update on every material change).
//
// `token_samples`: append-only rows with (session_id, tokens, percent, ts) for
// the stacked-memory graph. Garbage-collected by pruneTokenSamples.
//
// All queries use @named/$named bind parameters (PREVENT-002); local node:sqlite
// + WAL (PREVENT-PI-004), multi-process safe.
// ---------------------------------------------------------------------------

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
      const dir = eventsLogPath.includes("/") ? eventsLogPath.slice(0, eventsLogPath.lastIndexOf("/")) : ".";
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
  const result = db.prepare(
    "DELETE FROM session_heartbeats WHERE last_seen < @cutoff",
  ).run({ cutoff });
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
  const result = db.prepare(
    "DELETE FROM token_samples WHERE ts < @cutoff",
  ).run({ cutoff });
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
  const rows = db.prepare(
    `SELECT h.pid, h.session_id, h.repo_root, h.state_dir, h.ctx_window, h.last_seen,
            s.tokens, s.percent
     FROM session_heartbeats h
     LEFT JOIN token_samples s ON s.id = (
       SELECT id FROM token_samples t
       WHERE t.session_id = h.session_id
       ORDER BY t.ts DESC LIMIT 1
     )
     ORDER BY h.last_seen DESC`,
  ).all() as Array<{
    pid: number;
    session_id: string;
    repo_root: string | null;
    state_dir: string | null;
    ctx_window: number;
    last_seen: number;
    tokens: number | null;
    percent: number | null;
  }>;
  return rows.map((r) => ({
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
  const rows = db.prepare(
    `SELECT session_id, tokens, percent, ts FROM token_samples WHERE ts >= @since ORDER BY ts ASC`,
  ).all({ since: sinceMs }) as Array<{
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
