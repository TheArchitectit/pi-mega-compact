/**
 * api-contracts/endpoints.ts — Central registry of all dashboard API endpoints.
 *
 * Single source of truth for all 13 dashboard API routes. Each entry is an
 * `EndpointDef` (or `SseEndpointDef` for SSE) instance with method, path,
 * description, and typed request/response references.
 *
 * Sprint A1 — PREVENT-PI-004: zero network code (type definitions only).
 * PREVENT-011: no `any` type — all types are explicit.
 */

import type { EndpointDef } from './core.js';
import type { SnapshotResponse } from './snapshot.js';
import type { IndexesIndexRow, IndexesSummaryResponse } from './multi-repo.js';
import type { GameConfig, GameStateResponse } from './game.js';
import type { SseEvent } from './index.js';

// ─── New Response Types (inline) ───────────────────────────────────────────

/**
 * Response for GET /api/version. Returns the dashboard server version string
 * so the launcher can detect stale servers from older builds.
 */
export interface VersionResponse {
  /** Semver-style version string of the running dashboard server. */
  readonly version: string;
}

/**
 * Aggregated summary of the multi-repo index (subset of IndexesSummaryResponse).
 * Used by GET /api/summary for lightweight header tiles.
 */
export type IndexSummary = Pick<
  IndexesSummaryResponse,
  'totalRepos' | 'totalCheckpoints' | 'totalTokensSaved' | 'totalCompressedOriginalBytes'
>;

/**
 * Fallback response for GET /api/index when the multi-repo index is unavailable
 * (no index.sqlite file or read error). All fields are null/empty.
 */
export interface IndexFallbackResponse {
  /** Always null — no index data available. */
  readonly updatedAt: null;
  /** Always null — no summary available. */
  readonly summary: null;
  /** Always an empty array — no repos registered. */
  readonly repos: IndexesIndexRow[];
}

/**
 * Query parameters for GET /api/repos. The `active` parameter filters to repos
 * seen within the last N hours (format: "<N>h", e.g. "24h").
 */
export interface ReposQuery {
  /** Active-window filter in format "<hours>h" (e.g. "24h"). Optional. */
  readonly active?: string;
}

/**
 * Response for GET /api/repos. Returns the registry list with an optional
 * active-window filter applied.
 */
export interface ReposResponse {
  /** ISO timestamp of the last index update, or null if unavailable. */
  readonly updatedAt: string | null;
  /** Array of repo index rows. */
  readonly repos: IndexesIndexRow[];
  /** Number of repos in the response (after filtering). */
  readonly count: number;
}

/**
 * Response for GET /api/summary. Lightweight header tiles without the full
 * repo list (keeps payload small for embed scenarios).
 */
export interface SummaryResponse {
  /** ISO timestamp of the last index update, or null if unavailable. */
  readonly updatedAt: string | null;
  /** Aggregate index summary, or null if no index exists. */
  readonly summary: IndexSummary | null;
  /** Number of repos active within the last 24 hours. */
  readonly activeRepos: number;
  /** Total number of repos in the registry. */
  readonly totalRepos: number;
}

// ─── Drift Report Types ─────────────────────────────────────────────────────

/** Severity level for a drift signal. */
export type DriftSeverity = 'warn' | 'info';

/**
 * A single drift signal for a repo.
 */
export interface DriftSignal {
  /** The kind of drift detected. */
  readonly kind: 'stale' | 'compaction_lag' | 'model_churn';
  /** Severity level of the signal. */
  readonly severity: DriftSeverity;
  /** Human-readable detail describing the drift. */
  readonly detail: string;
}

/**
 * Drift classification for a single repo.
 */
export interface RepoDrift {
  /** Absolute path to the repo root. */
  readonly repoRoot: string;
  /** Display name of the repo. */
  readonly displayName: string;
  /** Unix timestamp (seconds) of the last dashboard activity. */
  readonly lastSeen: number;
  /** Unix timestamp (seconds) of the last compaction, or null if never. */
  readonly lastCompactedAt: number | null;
  /** Unix timestamp (seconds) of the last model capture, or null. */
  readonly modelCapturedAt: number | null;
  /** Array of drift signals detected for this repo. */
  readonly signals: DriftSignal[];
  /** Highest severity across signals; "ok" if none. */
  readonly status: 'ok' | 'warn';
}

/**
 * Response for GET /api/drift. Cross-repo drift report over the machine-wide
 * repo_registry, flagging stale repos, compaction lag, and model churn.
 */
export interface DriftReportResponse {
  /** Unix timestamp (seconds) when the report was generated. */
  readonly generatedAt: number;
  /** Aggregate counts by status/signal. */
  readonly totals: {
    /** Repos with no drift signals. */
    readonly ok: number;
    /** Repos with at least one warning signal. */
    readonly warn: number;
    /** Repos with the "stale" signal. */
    readonly stale: number;
    /** Repos with the "compaction_lag" signal. */
    readonly compactionLag: number;
    /** Repos with the "model_churn" signal. */
    readonly modelChurn: number;
  };
  /** Per-repo drift classifications. */
  readonly repos: RepoDrift[];
}

// ─── Servers Types ──────────────────────────────────────────────────────────

/**
 * A single server entry in the GET /api/servers response. Represents a
 * recently-active repo with its live dashboard snapshot data.
 */
export interface ServerEntry {
  /** Absolute path to the repo root. */
  readonly repoRoot: string;
  /** Display name of the repo. */
  readonly displayName: string;
  /** Model name, or null if not set. */
  readonly model: string | null;
  /** Provider display name, or null if not set. */
  readonly provider: string | null;
  /** Unix timestamp (seconds) of the last dashboard activity. */
  readonly lastSeen: number;
  /** Unix timestamp (seconds) of the last compaction, or null. */
  readonly lastCompactedAt: number | null;
  /** Current compaction tier, or null if no live snapshot. Present when a live dashboard.json exists. */
  readonly tier?: string | null;
  /** Current context pressure percentage (0–100), or null. Present when a live snapshot has context data. */
  readonly contextPct?: number | null;
  /** Current session state string, or null. Present when a live snapshot has session data. */
  readonly state?: string | null;
  /** Cache hit counters from the live snapshot, or null. Present when a live snapshot has cacheHits. */
  readonly cacheHits?: {
    readonly session: number;
    readonly total: number;
    readonly sessionTokensSaved: number;
    readonly totalTokensSaved: number;
  } | null;
  /** Compaction counters from the live snapshot, or null. Present when a live snapshot has compacts. */
  readonly compacts?: { readonly session: number; readonly total: number } | null;
  /** Time saved counters from the live snapshot, or null. Present when a live snapshot has timeSaved. */
  readonly timeSaved?: {
    readonly compact: { readonly sessionSec: number; readonly totalSec: number };
    readonly cacheHit: { readonly sessionSec: number; readonly totalSec: number };
  } | null;
  /** ISO timestamp of the live snapshot, or null. Present when a live snapshot has updatedAt. */
  readonly updatedAt?: string | null;
}

/**
 * Response for GET /api/servers. Lists recently-active repo servers with
 * live snapshot data.
 */
export interface ServersResponse {
  /** ISO timestamp when the response was generated. */
  readonly updatedAt: string;
  /** Array of server entries, sorted by lastSeen descending. */
  readonly servers: ServerEntry[];
}

// ─── Perf Types ─────────────────────────────────────────────────────────────

/** Percentile statistics for a latency metric (in milliseconds). */
export interface PerfPercentile {
  /** 50th percentile (median) in milliseconds. */
  readonly p50: number;
  /** 95th percentile in milliseconds. */
  readonly p95: number;
  /** Number of samples in the window. */
  readonly n: number;
}

/** Average statistics for a rate metric. */
export interface PerfAverage {
  /** Average value across all samples in the window. */
  readonly avg: number;
  /** Number of samples in the window. */
  readonly n: number;
}

/** Latest-value statistics for a gauge metric. */
export interface PerfLatest {
  /** Most recent value in the window. */
  readonly latest: number;
  /** Number of samples in the window. */
  readonly n: number;
}

/** Average + latest statistics for cache hit percentage. */
export interface PerfCacheHit {
  /** Average cache hit percentage (0–100). */
  readonly avg: number;
  /** Most recent cache hit percentage (0–100). */
  readonly latest: number;
  /** Number of samples in the window. */
  readonly n: number;
}

/** Diagnostic counters from the live dashboard snapshot. */
export interface PerfDiag {
  /** Number of fast-gate context trim fires. */
  readonly ctxFastGate: number;
  /** Number of live trim fires. */
  readonly liveTrimFires: number;
  /** Number of live trim replays. */
  readonly liveTrimReplays: number;
}

/**
 * Query parameters for GET /api/perf. The `minutes` parameter controls the
 * rolling window size.
 */
export interface PerfQuery {
  /** Rolling window size in minutes (default: 30, max: 1440). Optional. */
  readonly minutes?: number;
}

/**
 * Response for GET /api/perf. Rolling-window aggregates over perf_samples
 * with per-kind p50/p95, latest rss/heap, cpu counters, and diagnostic data.
 */
export interface PerfResponse {
  /** ISO timestamp when the response was generated. */
  readonly updatedAt: string;
  /** Rolling window size in minutes. */
  readonly windowMinutes: number;
  /** Total number of perf samples in the window. */
  readonly sampleCount: number;
  /** Turn latency statistics in milliseconds. */
  readonly turn_latency_ms: PerfPercentile;
  /** Provider latency statistics in milliseconds. */
  readonly provider_latency_ms: PerfPercentile;
  /** Tokens-per-second statistics. */
  readonly tps: PerfAverage;
  /** Cache hit percentage statistics. */
  readonly cache_hit_pct: PerfCacheHit;
  /** Database recompute duration statistics in milliseconds. */
  readonly db_recompute_ms: PerfPercentile;
  /** Disk write duration statistics in milliseconds. */
  readonly disk_write_ms: PerfPercentile;
  /** RSS memory usage in MB (latest value). */
  readonly rss_mb: PerfLatest;
  /** Heap memory usage in MB (latest value). */
  readonly heap_mb: PerfLatest;
  /** CPU user time in milliseconds (latest value). */
  readonly cpu_user_ms: PerfLatest;
  /** CPU system time in milliseconds (latest value). */
  readonly cpu_sys_ms: PerfLatest;
  /** Diagnostic counters from the live snapshot, or null if unavailable. */
  readonly diag: PerfDiag | null;
}

// ─── Game Score & Achievement Types ─────────────────────────────────────────

/**
 * A leaderboard row for GET /api/game-scores. One row per repo per metric.
 */
export interface GameScoreRow {
  /** Absolute path to the repo root. */
  readonly repo_root: string;
  /** Score value (interpretation depends on the metric). */
  readonly value: number;
  /** Unix timestamp (milliseconds) when the score was recorded. */
  readonly ts: number;
  /** Optional metadata associated with the score event. */
  readonly meta: unknown;
}

/**
 * Query parameters for GET /api/game-scores.
 */
export interface GameScoresQuery {
  /** Leaderboard metric (must be one of: cache, dedupe, turns, repos, mega_cache). Optional. */
  readonly metric?: string;
  /** Maximum number of rows to return (default: 10, clamped to [1, 100]). Optional. */
  readonly limit?: number;
}

/**
 * An achievement row for GET /api/achievements. One row per seeded achievement.
 */
export interface AchievementRow {
  /** Achievement identifier. */
  readonly id: string;
  /** Display title of the achievement. */
  readonly title: string;
  /** Description of the unlock condition. */
  readonly description: string;
  /** Whether the achievement is hidden (1 = hidden, 0 = visible). */
  readonly hidden: number;
  /** Icon identifier, or null if no icon. */
  readonly icon: string | null;
  /** Unix timestamp (seconds) when unlocked, or null if not yet unlocked. */
  readonly unlocked_at: number | null;
}

// ─── Game State Patch (PUT request body) ────────────────────────────────────

/**
 * Request body for PUT /api/game-state. A partial patch of the game config.
 * Unknown keys are ignored; invalid values result in a 400 response.
 */
export type GameStatePatch = Partial<GameConfig>;

// ─── SSE Endpoint Definition ────────────────────────────────────────────────

/**
 * Endpoint definition for SSE (Server-Sent Events) streaming endpoints.
 * Unlike standard REST endpoints, the response is a continuous `text/event-stream`
 * with `data:` frames containing JSON-serialized event objects.
 * @template Data - The SSE event data type streamed by this endpoint.
 */
export interface SseEndpointDef<Data extends SseEvent = SseEvent> {
  /** Discriminator: always 'sse' for streaming endpoints. */
  readonly type: 'sse';
  /** HTTP method (always 'GET' for SSE). */
  readonly method: 'GET';
  /** URL path of the endpoint. */
  readonly path: string;
  /** Human-readable description of the endpoint. */
  readonly description: string;
  /** SSE event name sent with each data frame. */
  readonly event: string;
  /** The SSE event data type streamed by this endpoint. */
  readonly dataType?: Data;
}

// ─── ENDPOINTS Registry ─────────────────────────────────────────────────────

/**
 * Central registry of all 13 dashboard API endpoints. Each entry is an
 * `EndpointDef` or `SseEndpointDef` instance serving as the single source of
 * truth for route paths, methods, descriptions, and typed request/response
 * contracts.
 *
 * Usage:
 *   import { ENDPOINTS } from './api-contracts';
 *   ENDPOINTS.snapshot.path   // '/api/snapshot'
 *   ENDPOINTS.snapshot.method // 'GET'
 */
export const ENDPOINTS = {
  /** GET /api/snapshot — Full session, store, compression, and context snapshot. */
  snapshot: {
    method: 'GET',
    path: '/api/snapshot',
    description: 'Full session, store, compression, and context snapshot.',
  } as const satisfies EndpointDef<'GET', undefined, SnapshotResponse>,

  /** GET /api/version — Dashboard server version string. */
  version: {
    method: 'GET',
    path: '/api/version',
    description: 'Dashboard server version for stale-server detection.',
  } as const satisfies EndpointDef<'GET', undefined, VersionResponse>,

  /** GET /api/index — Multi-repo aggregate index (or fallback when unavailable). */
  index: {
    method: 'GET',
    path: '/api/index',
    description: 'Machine-wide multi-repo registry with checkpoints, tokens, and model info.',
  } as const satisfies EndpointDef<'GET', undefined, IndexesSummaryResponse | IndexFallbackResponse>,

  /** GET /api/repos — Registry list with optional active-window filter. */
  repos: {
    method: 'GET',
    path: '/api/repos',
    description: 'Repo registry list, optionally filtered by recent activity.',
  } as const satisfies EndpointDef<'GET', ReposQuery, ReposResponse>,

  /** GET /api/summary — Lightweight header tiles without the full repo list. */
  summary: {
    method: 'GET',
    path: '/api/summary',
    description: 'Aggregate summary with active/total repo counts (no repo list).',
  } as const satisfies EndpointDef<'GET', undefined, SummaryResponse>,

  /** GET /api/drift — Cross-repo drift report. */
  drift: {
    method: 'GET',
    path: '/api/drift',
    description: 'Cross-repo drift report flagging stale repos, compaction lag, and model churn.',
  } as const satisfies EndpointDef<'GET', undefined, DriftReportResponse>,

  /** GET /api/servers — Recently-active repo servers with live snapshot data. */
  servers: {
    method: 'GET',
    path: '/api/servers',
    description: 'Recently-active repo servers with live snapshot data.',
  } as const satisfies EndpointDef<'GET', undefined, ServersResponse>,

  /** GET /api/events — SSE stream of dashboard events. */
  events: {
    type: 'sse',
    method: 'GET',
    path: '/api/events',
    description: 'Server-Sent Events stream of all dashboard events.',
    event: 'data',
  } as const satisfies SseEndpointDef<SseEvent>,

  /** GET /api/game-state — Current game-mode settings. */
  getGameState: {
    method: 'GET',
    path: '/api/game-state',
    description: 'Current game-mode configuration and active ritual state.',
  } as const satisfies EndpointDef<'GET', undefined, GameStateResponse>,

  /** PUT /api/game-state — Apply a partial patch to game-mode settings. */
  putGameState: {
    method: 'PUT',
    path: '/api/game-state',
    description: 'Apply a partial patch to game-mode settings and return the updated state.',
  } as const satisfies EndpointDef<'PUT', GameStatePatch, GameStateResponse>,

  /** GET /api/game-scores — High-score leaderboard for a metric. */
  gameScores: {
    method: 'GET',
    path: '/api/game-scores',
    description: 'High-score leaderboard for a game metric.',
  } as const satisfies EndpointDef<'GET', GameScoresQuery, GameScoreRow[]>,

  /** GET /api/perf — Rolling-window performance aggregates. */
  perf: {
    method: 'GET',
    path: '/api/perf',
    description: 'Rolling-window performance aggregates over perf_samples.',
  } as const satisfies EndpointDef<'GET', PerfQuery, PerfResponse>,

  /** GET /api/achievements — Achievement tiles with unlock state. */
  achievements: {
    method: 'GET',
    path: '/api/achievements',
    description: 'All achievement rows with unlock state.',
  } as const satisfies EndpointDef<'GET', undefined, AchievementRow[]>,
} as const;
