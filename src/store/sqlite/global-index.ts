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
import { existsSync, mkdirSync } from "node:fs";
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
