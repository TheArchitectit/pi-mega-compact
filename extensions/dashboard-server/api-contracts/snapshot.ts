/**
 * api-contracts/snapshot.ts — Snapshot / store / compression / session contracts.
 *
 * Contains: SnapshotResponse, TriggerResponse, CompressionTotalsResponse,
 * CompactHistoryEntry, CompactionRequest, CompactionResponse.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/snapshot ─────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/snapshot`.
 *
 * Provides a comprehensive real-time view of the compaction engine state,
 * including configuration, session info, context pressure, trigger status,
 * store metrics, crew status, per-repo statistics, integrity, cache hits,
 * time savings, and compression totals.
 */
export interface SnapshotResponse {
  /** ISO 8601 timestamp of the last snapshot update, or `null` if never updated. */
  updatedAt: string | null;
  /** Currently active compaction tier name (e.g. `'ultra-compact'`, `'super-compact'`). */
  tier: string;
  /** Preset (default) compaction tier name before any override. */
  presetTier: string;
  /** Current context pressure (percent, 0–100). */
  pressure: number;
  /** Active compaction configuration. */
  config: {
    /** Fast-gate pressure threshold (percent, 0–100). Compaction fires early when pressure exceeds this. */
    fastGatePct: number;
    /** Token threshold at which standard compaction triggers (tokens). */
    thresholdTokens: number;
    /** Number of recent user messages preserved as anchors during compaction. */
    anchorUserMessages: number;
    /** Number of recent messages always preserved (never compacted). */
    preserveRecent: number;
    /** Whether auto-compaction is enabled. */
    auto: boolean;
    /** Number of recalled chunks to inline per compaction cycle. */
    autoInlineK: number;
  };
  /** Current session state. */
  session: {
    /** Active session ID, or `null` when no session is active. */
    id: string | null;
    /** Session lifecycle state (e.g. `'idle'`, `'compacting'`), or `null` when no session is active. */
    state: string | null;
    /** Whether a checkpoint has been persisted during this session. */
    persistedThisSession: boolean;
    /** ID of the most recent checkpoint, or `null` if none exists. */
    lastCheckpointId: string | null;
    /** Token count the context had before the last compaction (tokens). */
    lastCompactedFrom: number;
  };
  /** Current context window utilization. */
  context: {
    /** Current token count in the context window, or `null` if unknown (tokens). */
    tokens: number | null;
    /** Context window usage as a percentage of the window size, or `null` if unknown (percent, 0–100). */
    percent: number | null;
    /** Maximum context window size for the active model (tokens). */
    contextWindow: number;
  };
  /** Compaction trigger status. */
  trigger: {
    /** Whether the trigger is armed (waiting for threshold). */
    armed: boolean;
    /** Whether the trigger is ready to fire (pressure at or above threshold). */
    ready: boolean;
    /** Current context token count, or `null` if unknown (tokens). */
    currentTokens: number | null;
    /** Token threshold for firing (tokens). */
    thresholdTokens: number;
    /** Fast-gate pressure threshold (percent, 0–100). */
    fastGatePct: number;
  };
  /** Aggregate store metrics (all sessions). */
  store: {
    /** Total number of checkpoints across all sessions. */
    checkpointCount: number;
    /** Estimated total tokens across all checkpoints (tokens). */
    totalTokenEstimate: number;
    /** Original token count before any compaction (tokens). */
    originalTokens: number;
    /** Total tokens saved through compaction (tokens). */
    tokensSaved: number;
    /** Number of recalled chunks injected into contexts. */
    injectedCount: number;
    /** Deduplication hit rate (percent, 0–100). */
    dedupHitRate: number;
    /** Storage deduplication rate — fraction of bytes deduplicated (percent, 0–100). */
    storageDedupRate: number;
    /** Number of duplicate chunks collapsed by dedup. */
    dedupCollapsed: number;
  };
  /** Crew (multi-agent) status. */
  crew: {
    /** Number of active crew agents. */
    activeAgents: number;
    /** Current turn index in the crew round-robin. */
    currentTurn: number;
  };
  /** Per-repo (current repository) statistics. */
  repo: {
    /** Number of checkpoints for the current repo. */
    checkpointCount: number;
    /** Estimated total tokens for the current repo (tokens). */
    totalTokenEstimate: number;
    /** Original token count for the current repo before compaction (tokens). */
    originalTokens: number;
    /** Tokens saved for the current repo (tokens). */
    tokensSaved: number;
    /** Number of sessions recorded for the current repo. */
    sessionCount: number;
    /** Number of dedup attempts for the current repo. */
    dedupAttempts: number;
    /** Number of duplicate chunks collapsed for the current repo. */
    dedupCollapsed: number;
    /** Storage deduplication rate for the current repo (percent, 0–100). */
    storageDedupRate: number;
  };
  /** Data integrity metrics. */
  integrity: {
    /** Number of regions retained after compaction. */
    regionsRetained: number;
    /** Original byte size of compressed data before dedup (bytes). */
    compressedOriginalBytes: number;
    /** Number of duplicate chunks collapsed. */
    duplicatesCollapsed: number;
    /** Bytes permanently deleted during compaction (bytes). */
    bytesPermanentlyDeleted: number;
  };
  /** Cache hit statistics. */
  cacheHits: {
    /** Cache hits in the current session. */
    session: number;
    /** Total cache hits across all sessions. */
    total: number;
    /** Tokens saved by cache hits this session (tokens). */
    sessionTokensSaved: number;
    /** Total tokens saved by cache hits (tokens). */
    totalTokensSaved: number;
  };
  /** Compaction run counts. */
  compacts: {
    /** Compactions performed this session. */
    session: number;
    /** Total compactions performed. */
    total: number;
  };
  /** Estimated time saved by compaction and cache hits. */
  timeSaved: {
    /** Time saved by compaction. */
    compact: {
      /** Seconds saved by compaction this session (seconds). */
      sessionSec: number;
      /** Total seconds saved by compaction (seconds). */
      totalSec: number;
    };
    /** Time saved by cache hits. */
    cacheHit: {
      /** Seconds saved by cache hits this session (seconds). */
      sessionSec: number;
      /** Total seconds saved by cache hits (seconds). */
      totalSec: number;
    };
  };
  /** Compression statistics for session and repo. */
  compression: {
    /** Session-level compression. */
    session: {
      /** Input tokens for the session (tokens). */
      tokensIn: number;
      /** Output tokens after compression for the session (tokens). */
      tokensOut: number;
      /** Tokens freed by compression for the session (tokens). */
      tokensFreed: number;
      /** Compression ratio for the session (percent, 0–100). */
      compressionPct: number;
      /** Dedup contribution for the session (percent, 0–100). */
      dedupPct: number;
    };
    /** Repo-level compression. */
    repo: {
      /** Input tokens for the repo (tokens). */
      tokensIn: number;
      /** Output tokens after compression for the repo (tokens). */
      tokensOut: number;
      /** Tokens freed by compression for the repo (tokens). */
      tokensFreed: number;
      /** Compression ratio for the repo (percent, 0–100). */
      compressionPct: number;
      /** Dedup contribution for the repo (percent, 0–100). */
      dedupPct: number;
    };
  };
  /** Active model information. Present when a model is configured and active; absent otherwise. */
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

// ─── /api/trigger ──────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/trigger`.
 *
 * Reports the current compaction trigger status, mirroring the `trigger`
 * sub-object from `SnapshotResponse`.
 */
export interface TriggerResponse {
  /** Whether the trigger is armed (waiting for threshold). */
  armed: boolean;
  /** Whether the trigger is ready to fire (pressure at or above threshold). */
  ready: boolean;
  /** Current context token count, or `null` if unknown (tokens). */
  currentTokens: number | null;
  /** Token threshold for firing (tokens). */
  thresholdTokens: number;
  /** Fast-gate pressure threshold (percent, 0–100). */
  fastGatePct: number;
}

// ─── /api/compression-totals ───────────────────────────────────────────────

/**
 * Response body for `GET /api/compression-totals`.
 *
 * Summarizes compression, dedup, cache hit, and time-saved metrics at both
 * session and repo levels.
 */
export interface CompressionTotalsResponse {
  /** Repo-level compression statistics. */
  repo: {
    /** Input tokens for the repo (tokens). */
    tokensIn: number;
    /** Output tokens after compression for the repo (tokens). */
    tokensOut: number;
    /** Tokens freed by compression for the repo (tokens). */
    tokensFreed: number;
    /** Compression ratio for the repo (percent, 0–100). */
    compressionPct: number;
    /** Dedup contribution for the repo (percent, 0–100). */
    dedupPct: number;
  };
  /** Session-level compression statistics. */
  session: {
    /** Input tokens for the session (tokens). */
    tokensIn: number;
    /** Output tokens after compression for the session (tokens). */
    tokensOut: number;
    /** Tokens freed by compression for the session (tokens). */
    tokensFreed: number;
    /** Compression ratio for the session (percent, 0–100). */
    compressionPct: number;
    /** Dedup contribution for the session (percent, 0–100). */
    dedupPct: number;
  };
  /** Compaction run counts. */
  compacts: {
    /** Compactions performed this session. */
    session: number;
    /** Total compactions performed. */
    total: number;
  };
  /** Cache hit statistics. */
  cacheHits: {
    /** Cache hits in the current session. */
    session: number;
    /** Total cache hits across all sessions. */
    total: number;
    /** Tokens saved by cache hits this session (tokens). */
    sessionTokensSaved: number;
    /** Total tokens saved by cache hits (tokens). */
    totalTokensSaved: number;
  };
  /** Estimated time saved by compaction and cache hits. */
  timeSaved: {
    /** Time saved by compaction. */
    compact: {
      /** Seconds saved by compaction this session (seconds). */
      sessionSec: number;
      /** Total seconds saved by compaction (seconds). */
      totalSec: number;
    };
    /** Time saved by cache hits. */
    cacheHit: {
      /** Seconds saved by cache hits this session (seconds). */
      sessionSec: number;
      /** Total seconds saved by cache hits (seconds). */
      totalSec: number;
    };
  };
}

// ─── /api/compact-history ─────────────────────────────────────────────────

/**
 * Response body for `GET /api/compact-history` (individual entry).
 *
 * Represents a single compaction event in the history log.
 */
export interface CompactHistoryEntry {
  /** Unique identifier for this history entry. */
  id: string;
  /** ISO 8601 timestamp of the compaction. */
  ts: string;
  /** Compaction tier used (e.g. `'ultra-compact'`, `'super-compact'`). */
  tier: string;
  /**
   * What triggered the compaction.
   * Allowed values: `'manual'`, `'auto'`, `'fast-gate'`, `'ctx-pressure'`.
   */
  trigger: 'manual' | 'auto' | 'fast-gate' | 'ctx-pressure';
  /** Checkpoint count before the compaction. */
  checkpointBefore: number;
  /** Checkpoint count after the compaction. */
  checkpointAfter: number;
  /** Context token count before the compaction (tokens). */
  contextBefore: number;
  /** Context token count after the compaction (tokens). */
  contextAfter: number;
  /** Input tokens consumed by the compaction (tokens). */
  tokensIn: number;
  /** Output tokens after the compaction (tokens). */
  tokensOut: number;
  /** Tokens freed by the compaction (tokens). */
  tokensFreed: number;
  /** Number of duplicate chunks collapsed during this compaction. Present when dedup ran; absent otherwise. */
  dedupCollapsed?: number;
}

// ─── POST /api/compact ─────────────────────────────────────────────────────

/**
 * Request body for `POST /api/compact`.
 *
 * Optionally specifies a compaction target mode and reason.
 */
export interface CompactionRequest {
  /**
   * Compaction intensity target.
   * Allowed values: `'aggressive'`, `'standard'`, `'fast-gate'`.
   * Absent when default (`'standard'`) should be used.
   */
  target?: 'aggressive' | 'standard' | 'fast-gate';
  /** Human-readable reason for the compaction. Absent when no reason is provided. */
  reason?: string;
}

/**
 * Response body for `POST /api/compact`.
 *
 * Reports the outcome of a compaction request.
 */
export interface CompactionResponse {
  /**
   * Outcome status.
   * Allowed values: `'ok'`, `'error'`, `'skipped'`.
   */
  status: 'ok' | 'error' | 'skipped';
  /** Token count before compaction (tokens). Present on successful compaction; absent otherwise. */
  beforeTokens?: number;
  /** Token count after compaction (tokens). Present on successful compaction; absent otherwise. */
  afterTokens?: number;
  /** Tokens freed by the compaction (tokens). Present on successful compaction; absent otherwise. */
  tokensFreed?: number;
  /** Compaction tier used. Present on successful compaction; absent otherwise. */
  tier?: string;
  /** Checkpoint ID produced. Present on successful compaction; absent otherwise. */
  checkpointId?: string;
  /** Duration of the compaction (milliseconds). Present on successful compaction; absent otherwise. */
  durationMs?: number;
  /** Human-readable message (e.g. error detail or skip reason). Present when a message is available; absent otherwise. */
  message?: string;
}
