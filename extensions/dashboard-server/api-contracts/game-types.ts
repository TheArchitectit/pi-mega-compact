/**
 * api-contracts/game-types.ts — Split-out dashboard API types.
 *
 * Contains the “Game Score & Achievement Types” and “Sessions Memory Graph”
 * related type definitions that previously lived in endpoints.ts.
 */

import type { GameConfig } from './game.js';
import type { SseEvent } from './index.js';

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

// ─── Sessions Memory Graph (S39) ─────────────────────────────────────────

/**
 * A single active session in the GET /api/sessions response. Represents a
 * live pi process with its latest token usage and heartbeat.
 */
export interface ActiveSession {
  /** OS process ID of the pi process. */
  readonly pid: number;
  /** Session identifier (normalized). */
  readonly sessionId: string;
  /** Absolute path to the repo root, or null if not in a git repo. */
  readonly repoRoot: string | null;
  /** Display name (repo basename or state dir basename). */
  readonly displayName: string;
  /** Model name, or null if not captured. Available from repo_registry join. */
  readonly model: string | null;
  /** Latest context token count, or null if no sample yet. */
  readonly tokens: number | null;
  /** Latest context pressure percentage (0–100), or null. */
  readonly percent: number | null;
  /** Context window size in tokens. */
  readonly ctxWindow: number;
  /** Unix timestamp (ms) of the last heartbeat. */
  readonly lastSeen: number;
  /** State directory of the session. */
  readonly stateDir: string | null;
}

/**
 * Response for GET /api/sessions. Lists active sessions with their latest
 * token usage after pruning stale entries.
 */
export interface SessionsResponse {
  /** ISO timestamp when the response was generated. */
  readonly updatedAt: string;
  /** Number of stale sessions pruned during this request. */
  readonly pruned: number;
  /** Array of active sessions, sorted by lastSeen descending. */
  readonly sessions: ActiveSession[];
}

/** A single time-series data point for a session. */
export interface SessionDataPoint {
  /** Unix timestamp (ms). */
  readonly ts: number;
  /** Token count at this sample. */
  readonly tokens: number;
  /** Context pressure percentage (0–100). */
  readonly percent: number;
}

/** A recharts-ready per-session series with a stable color. */
export interface SessionSeries {
  /** Session identifier. */
  readonly sessionId: string;
  /** Short display label for the legend. */
  readonly label: string;
  /** Stable hex color string (e.g. "#60a5fa"). */
  readonly color: string;
  /** Data points ordered by timestamp ascending. */
  readonly data: SessionDataPoint[];
}

/**
 * Query parameters for GET /api/sessions/timeseries. The `minutes` parameter
 * controls the rolling window size.
 */
export interface SessionTimeseriesQuery {
  /** Rolling window size in minutes (default: 30, clamped to [1, 1440]). */
  readonly minutes?: number;
}

/**
 * Response for GET /api/sessions/timeseries. Returns recharts-ready stacked
 * per-session series + a totals array.
 */
export interface SessionTimeseriesResponse {
  /** ISO timestamp when the response was generated. */
  readonly updatedAt: string;
  /** Rolling window size in minutes. */
  readonly windowMinutes: number;
  /** Per-session series with stable colors. */
  readonly series: SessionSeries[];
  /** Totals (sum of all sessions) per timestamp. */
  readonly totals: { readonly ts: number; readonly tokens: number }[];
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
