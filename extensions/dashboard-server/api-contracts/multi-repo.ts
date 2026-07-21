/**
 * api-contracts/multi-repo.ts — Multi-repo index and repo management contracts.
 *
 * Contains: RepoListItem, RepoSnapshotEntry, RepoSnapshotMap,
 * IndexesIndexRow, IndexesSummaryResponse, IndexesDiffEntry,
 * DiffRequest, DiffResponse, UpdateRepoConfigRequest.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/repos ────────────────────────────────────────────────────────────

/**
 * Response item for `GET /api/repos`.
 *
 * Represents a single repository in the multi-repo index list.
 */
export interface RepoListItem {
  /** Unique repository identifier. */
  id: string;
  /** Filesystem path to the repository root. */
  path: string;
  /** Human-readable repository display name. */
  name: string;
  /** Number of sessions recorded for this repository. */
  sessionCount: number;
  /** Total token count across all sessions for this repository (tokens). */
  tokenTotal: number;
  /** Epoch timestamp of the last activity for this repository (milliseconds since Unix epoch). */
  lastSeen: number;
}

// ─── /api/repo-snapshot ────────────────────────────────────────────────────

/**
 * Response item for `GET /api/repo-snapshot`.
 *
 * Per-repository snapshot entry containing tier, pressure, session, context,
 * store, compression, and model information.
 */
export interface RepoSnapshotEntry {
  /** ISO 8601 timestamp of the last update, or `null` if never updated. */
  updatedAt: string | null;
  /** Currently active compaction tier name for this repo. */
  tier: string;
  /** Preset (default) compaction tier name for this repo. */
  presetTier: string;
  /** Current context pressure for this repo (percent, 0–100). */
  pressure: number;
  /** Session state for this repo. */
  session: {
    /** Active session ID, or `null` when no session is active. */
    id: string | null;
    /** Session lifecycle state (e.g. `'idle'`, `'compacting'`), or `null` when no session is active. */
    state: string | null;
  };
  /** Context window utilization for this repo. */
  context: {
    /** Current token count, or `null` if unknown (tokens). */
    tokens: number | null;
    /** Context window usage, or `null` if unknown (percent, 0–100). */
    percent: number | null;
    /** Maximum context window size for the active model (tokens). */
    contextWindow: number;
  };
  /** Store metrics for this repo. */
  store: {
    /** Number of checkpoints for this repo. */
    checkpointCount: number;
    /** Tokens saved for this repo (tokens). */
    tokensSaved: number;
    /** Number of duplicate chunks collapsed for this repo. */
    dedupCollapsed: number;
    /** Storage deduplication rate for this repo (percent, 0–100). */
    storageDedupRate: number;
  };
  /** Compression statistics for this repo. */
  compression: {
    /** Session-level compression. */
    session: {
      /** Input tokens for the session (tokens). */
      tokensIn: number;
      /** Output tokens after compression (tokens). */
      tokensOut: number;
      /** Tokens freed by compression (tokens). */
      tokensFreed: number;
      /** Compression ratio (percent, 0–100). */
      compressionPct: number;
      /** Dedup contribution (percent, 0–100). */
      dedupPct: number;
    };
    /** Repo-level compression. */
    repo: {
      /** Input tokens for the repo (tokens). */
      tokensIn: number;
      /** Output tokens after compression (tokens). */
      tokensOut: number;
      /** Tokens freed by compression (tokens). */
      tokensFreed: number;
      /** Compression ratio (percent, 0–100). */
      compressionPct: number;
      /** Dedup contribution (percent, 0–100). */
      dedupPct: number;
    };
  };
  /** Active model information for this repo. Present when a model is configured; absent otherwise. */
  model?: {
    /** Model name/identifier. */
    name: string;
    /** Machine-readable provider identifier. */
    provider: string;
    /** Human-readable provider name. */
    providerName: string;
    /** Model input processing rate (tokens per second). */
    inputRate: number;
    /** Model output processing rate (tokens per second). */
    outputRate: number;
  };
}

/**
 * Map of repository IDs to their snapshot entries.
 *
 * Used as the response body for `GET /api/repo-snapshot`.
 * Values are `null` when a repo has no snapshot data.
 */
export type RepoSnapshotMap = Record<string, RepoSnapshotEntry | null>;

// ─── /api/indexes ──────────────────────────────────────────────────────────

/**
 * Row in the `GET /api/index` response.
 *
 * Represents a single repository's index entry with checkpoint, token,
 * compression, model, and configuration details.
 */
export interface IndexesIndexRow {
  /** Filesystem path to the repository root. */
  repoRoot: string;
  /** Human-readable display name for the repository. */
  displayName: string;
  /** State directory path for this repo's mega-compact data. */
  stateDir: string;
  /** Number of checkpoints stored for this repo. */
  checkpointCount: number;
  /** Total tokens saved for this repo (tokens). */
  tokensSaved: number;
  /** Original byte size of compressed data (bytes). */
  compressedOriginalBytes: number;
  /** Epoch timestamp of the last compaction, or `null` if never compacted (milliseconds since Unix epoch). */
  lastCompactedAt: number | null;
  /** Machine-readable provider identifier, or `null` if not configured. */
  provider: string | null;
  /** Human-readable provider name, or `null` if not configured. */
  providerName: string | null;
  /** Model name/identifier, or `null` if not configured. */
  modelName: string | null;
  /** Model input processing rate, or `null` if not configured (tokens per second). */
  inputRate: number | null;
  /** Model output processing rate, or `null` if not configured (tokens per second). */
  outputRate: number | null;
  /** Epoch timestamp of the last activity (milliseconds since Unix epoch). */
  lastSeen: number;
  /** Tokens retained after compaction (tokens). */
  tokensKept: number;
  /** Tokens dropped during compaction (tokens). */
  tokensDropped: number;
  /** Number of sessions recorded for this repo. */
  sessions: number;
  /** Maximum context window size, or `null` if not configured (tokens). */
  contextWindow: number | null;
  /** Maximum token limit, or `null` if not configured (tokens). */
  maxTokens: number | null;
  /** Whether reasoning/extended-thinking mode is enabled, or `null` if not configured. */
  reasoning: boolean | null;
}

/**
 * Response body for `GET /api/index`.
 *
 * Provides an aggregated summary of all repos plus a per-repo index row list.
 */
export interface IndexesSummaryResponse {
  /** ISO 8601 timestamp of the last index update. */
  updatedAt: string;
  /** Total number of repos in the index. */
  totalRepos: number;
  /** Total number of checkpoints across all repos. */
  totalCheckpoints: number;
  /** Total tokens saved across all repos (tokens). */
  totalTokensSaved: number;
  /** Total original compressed byte size across all repos (bytes). */
  totalCompressedOriginalBytes: number;
  /** Per-repo index rows. */
  repos: IndexesIndexRow[];
}

// ─── /api/indexes/diff ─────────────────────────────────────────────────────

/**
 * Single diff entry in the `GET /api/indexes/diff` response.
 *
 * Describes one change between a client-provided snapshot and the server's
 * current state.
 */
export interface IndexesDiffEntry {
  /** Unique identifier for this diff entry. */
  id: string;
  /**
   * Type of change detected.
   * Allowed values: `'add'`, `'remove'`, `'change'`.
   */
  type: 'add' | 'remove' | 'change';
  /** Repository involved in the diff. Present when the change is repo-specific; absent otherwise. */
  repo?: string;
  /** Field name that changed. Present for `'change'` type; absent otherwise. */
  field?: string;
  /** Previous value of the changed field. Present for `'change'` type; absent otherwise. */
  before?: unknown;
  /** New value of the changed field. Present for `'change'` and `'add'` types; absent otherwise. */
  after?: unknown;
  /**
   * Severity of the change.
   * Allowed values: `'info'`, `'warn'`, `'critical'`.
   */
  severity: 'info' | 'warn' | 'critical';
}

/**
 * Request body for `POST /api/indexes/diff`.
 *
 * Specifies which side (client or server) is providing the snapshot for
 * comparison, and optionally includes the snapshot itself.
 */
export interface DiffRequest {
  /**
   * Which side is providing the snapshot for comparison.
   * Allowed values: `'client'`, `'server'`.
   */
  side: 'client' | 'server';
  /** Snapshot to compare against. Present when `side` is `'client'`; absent when `side` is `'server'` (server uses its own). */
  snapshot?: SnapshotLike;
}

/**
 * Minimal shape for snapshot comparison (avoids coupling to full SnapshotResponse).
 *
 * Used by `DiffRequest` and `DiffResponse` to represent a partial snapshot
 * for drift detection.
 */
export interface SnapshotLike {
  /** ISO 8601 timestamp of the snapshot, or `null`. Absent when not available. */
  updatedAt?: string | null;
  /** Store metrics subset. Absent when not available. */
  store?: {
    /** Number of checkpoints. Absent when not available. */
    checkpointCount?: number;
    /** Tokens saved (tokens). Absent when not available. */
    tokensSaved?: number;
  };
  /** Compression statistics subset. Absent when not available. */
  compression?: {
    /** Repo-level compression subset. Absent when not available. */
    repo?: {
      /** Input tokens (tokens). Absent when not available. */
      tokensIn?: number;
      /** Output tokens (tokens). Absent when not available. */
      tokensOut?: number;
      /** Compression ratio (percent, 0–100). Absent when not available. */
      compressionPct?: number;
      /** Dedup contribution (percent, 0–100). Absent when not available. */
      dedupPct?: number;
    };
    /** Session-level compression subset. Absent when not available. */
    session?: {
      /** Input tokens (tokens). Absent when not available. */
      tokensIn?: number;
      /** Output tokens (tokens). Absent when not available. */
      tokensOut?: number;
    };
  };
  /** Session state subset. Absent when not available. */
  session?: {
    /** Active session ID, or `null`. Absent when not available. */
    id?: string | null;
    /** Session lifecycle state, or `null`. Absent when not available. */
    state?: string | null;
  };
  /** Model info subset. Absent when not available. */
  model?: {
    /** Model name. Absent when not available. */
    name?: string;
    /** Provider identifier. Absent when not available. */
    provider?: string;
  };
  /** Trigger state subset. Absent when not available. */
  trigger?: {
    /** Whether the trigger is armed. Absent when not available. */
    armed?: boolean;
    /** Whether the trigger is ready. Absent when not available. */
    ready?: boolean;
  };
}

/**
 * Response body for `POST /api/indexes/diff`.
 *
 * Contains the list of detected diffs and the server's current snapshot.
 */
export interface DiffResponse {
  /** List of detected differences between client and server snapshots. */
  diffs: IndexesDiffEntry[];
  /** The server's current snapshot used as the comparison baseline. */
  serverSnapshot: SnapshotLike;
}

// ─── PUT /api/repo-config ─────────────────────────────────────────────────

/**
 * Request body for `PUT /api/repo-config`.
 *
 * Updates display configuration for a specific repository.
 */
export interface UpdateRepoConfigRequest {
  /** Repository identifier to update. */
  repoId: string;
  /** New display name for the repository. Absent when the display name should not be changed. */
  displayName?: string;
}
