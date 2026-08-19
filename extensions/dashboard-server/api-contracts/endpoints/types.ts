/**
 * api-contracts/endpoints/types.ts — inline response/query types for the
 * endpoint registry.
 *
 * Extracted from endpoints.ts (delegate-shell split). Holds the response types
 * that were defined inline (version/drift/servers/perf) plus the backwards-
 * compatible re-export of the types that migrated to game-types.ts.
 *
 * PREVENT-PI-004: zero network code (type definitions only).
 * PREVENT-011: no `any` type — all types are explicit.
 */
import type { IndexesIndexRow, IndexesSummaryResponse } from "../multi-repo.js";

// ─── Game Score & Achievement Types ─────────────────────────────────────────
// (moved to game-types.ts; re-exported for backwards compatibility)

// ─── Sessions Memory Graph (S39) ─────────────────────────────────────────
// (moved to game-types.ts; re-exported for backwards compatibility)

// ─── Game State Patch (PUT request body) ────────────────────────────────────
// (moved to game-types.ts; re-exported for backwards compatibility)

// ─── SSE Endpoint Definition ────────────────────────────────────────────────
// (moved to game-types.ts; re-exported for backwards compatibility)

export type {
	GameScoreRow,
	GameScoresQuery,
	AchievementRow,
	ActiveSession,
	SessionsResponse,
	SessionDataPoint,
	SessionSeries,
	SessionTimeseriesQuery,
	SessionTimeseriesResponse,
	GameStatePatch,
	SseEndpointDef,
	TopicRow,
	TopicAssignmentRow,
	TopicsResponse,
	TopicDetailResponse,
} from "../game-types.js";

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
	| "totalRepos"
	| "totalCheckpoints"
	| "totalTokensSaved"
	| "totalCompressedOriginalBytes"
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
export type DriftSeverity = "warn" | "info";

/**
 * A single drift signal for a repo.
 */
export interface DriftSignal {
	/** The kind of drift detected. */
	readonly kind: "stale" | "compaction_lag" | "model_churn";
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
	readonly status: "ok" | "warn";
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
	readonly compacts?: {
		readonly session: number;
		readonly total: number;
	} | null;
	/** Time saved counters from the live snapshot, or null. Present when a live snapshot has timeSaved. */
	readonly timeSaved?: {
		readonly compact: {
			readonly sessionSec: number;
			readonly totalSec: number;
		};
		readonly cacheHit: {
			readonly sessionSec: number;
			readonly totalSec: number;
		};
	} | null;
	/** ISO timestamp of the live snapshot, or null. Present when a live snapshot has updatedAt. */
	readonly updatedAt?: string | null;
	/** Provider prompt-cache lifetime aggregates for this repo, or null when unavailable. */
	readonly providerCache?: {
		readonly avgHitPct: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalInput: number;
		readonly sampleCount: number;
		readonly estimatedSaved: number | null;
	} | null;
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

/** A single cache hit rate sample with timestamp. */
export interface CacheHitSample {
	/** Cache hit percentage (0–100). */
	readonly pct: number;
	/** Epoch ms timestamp of the sample. */
	readonly ts: number;
}

/** Average + latest statistics for cache hit percentage. */
export interface PerfCacheHit {
	/** Average cache hit percentage (0–100). */
	readonly avg: number;
	/** Most recent cache hit percentage (0–100). */
	readonly latest: number;
	/** Number of samples in the window. */
	readonly n: number;
	/** Raw cache hit samples with timestamps for time-series charting. */
	readonly samples: CacheHitSample[];
}

/** Diagnostic counters from the live dashboard snapshot. */
export interface PerfDiag {
	/** Number of fast-gate context trim fires. */
	readonly ctxFastGate: number;
	/** Number of live trim fires. */
	readonly liveTrimFires: number;
	/** Number of live trim replays. */
	readonly liveTrimReplays: number;
	/** v0.21.9: output-headroom gate trips (pre-overflow compaction fires). */
	readonly headroomTrips: number;
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

/**
 * Query parameters for GET /api/perf/samples. `kind` selects which perf metric
 * to return raw samples for; `minutes` controls the rolling window size.
 */
export interface PerfSamplesQuery {
	/** Perf metric kind (turn_latency_ms, tps, disk_write_ms, cache_hit_pct, ...). Required. */
	readonly kind: string;
	/** Rolling window size in minutes (default: 60). Optional. */
	readonly minutes?: number;
}

/** A single raw perf sample for time-series charting. */
export interface PerfSamplePoint {
	/** Epoch ms timestamp of the sample. */
	readonly ts: number;
	/** Sample value for the requested kind. */
	readonly value: number;
	/** Optional stringified metadata associated with the sample. */
	readonly meta?: string;
}

/**
 * Response for GET /api/perf/samples. Raw perf samples for a single kind,
 * ascending by ts, for chart drill-down in the Perf tab.
 */
export interface PerfSamplesResponse {
	/** Array of raw samples ascending by ts. */
	readonly samples: PerfSamplePoint[];
	/** The requested perf kind. */
	readonly kind: string;
	/** The rolling window size in minutes used. */
	readonly minutes: number;
	/** Epoch ms timestamp when the response was generated. */
	readonly updatedAt: number;
}
