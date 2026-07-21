/**
 * api-contracts/core.ts — Core types shared across all API domains.
 *
 * Contains: generic endpoint definition, HTTP method, SSE event types.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── Endpoint Method ────────────────────────────────────────────────────────

/**
 * HTTP methods supported by the dashboard API.
 *
 * Allowed values: `'GET'`, `'PUT'`, `'POST'`.
 */
export type HttpMethod = 'GET' | 'PUT' | 'POST';

// ─── Generic Endpoint Definition ────────────────────────────────────────────

/**
 * Generic definition for a dashboard API endpoint.
 *
 * Each concrete endpoint in the `ENDPOINTS` registry is an instance of this
 * interface, carrying the HTTP method, path, human-readable description, and
 * optional typed request/response schemas.
 *
 * @template M  - The HTTP method (GET, PUT, or POST).
 * @template Req - The request body or query-string shape (if any).
 * @template Res - The response body shape.
 */
export interface EndpointDef<M extends HttpMethod, Req, Res> {
  /** HTTP method for this endpoint. */
  readonly method: M;
  /** URL path beginning with `/api/`. */
  readonly path: string;
  /** Human-readable summary of the endpoint's purpose. */
  readonly description: string;
  /** Request schema (body or query params), present when the endpoint accepts input. */
  readonly requestSchema?: Req;
  /** Response schema, present when the endpoint returns a typed body. */
  readonly responseSchema?: Res;
}

// ─── SSE Event Types ────────────────────────────────────────────────────────

/**
 * SSE event emitted when a compaction cycle starts.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCompactStart {
  /** Discriminator. Always `'compact_start'`. */
  type: 'compact_start';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /**
   * What triggered the compaction.
   * Allowed values: `'auto'`, `'manual'`, `'fast-gate'`, `'ctx-pressure'`.
   */
  trigger: 'auto' | 'manual' | 'fast-gate' | 'ctx-pressure';
  /** Session identifier the compaction is running in. */
  sessionId: string;
}

/**
 * SSE event emitted when a compaction cycle finishes.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCompactEnd {
  /** Discriminator. Always `'compact_end'`. */
  type: 'compact_end';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Session identifier the compaction ran in. */
  sessionId: string;
  /** Checkpoint ID produced by the compaction. */
  checkpointId: string;
  /** Number of input tokens consumed by the compaction (tokens). */
  tokensIn: number;
  /** Number of output tokens after compaction (tokens). */
  tokensOut: number;
  /** Number of tokens freed (tokensIn − tokensOut, in tokens). */
  tokensFreed: number;
  /** Whether the compaction completed successfully. */
  success: boolean;
}

/**
 * SSE event emitted when the compaction trigger state changes
 * (pressure crossing a threshold or being armed/disarmed).
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCompactTrigger {
  /** Discriminator. Always `'compact_trigger'`. */
  type: 'compact_trigger';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Current context pressure (percent, 0–100). */
  pressure: number;
  /** Threshold at which compaction will fire (percent, 0–100). */
  threshold: number;
  /** Whether the trigger is currently armed. */
  armed: boolean;
}

/**
 * SSE event emitted when a compaction is skipped (e.g. pressure insufficient).
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCompactSkip {
  /** Discriminator. Always `'compact_skip'`. */
  type: 'compact_skip';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Human-readable reason the compaction was skipped. */
  reason: string;
}

/**
 * SSE event emitted when the active compaction tier changes.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseTierChanged {
  /** Discriminator. Always `'tier_changed'`. */
  type: 'tier_changed';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Previous tier name. */
  from: string;
  /** New tier name. */
  to: string;
  /** Context pressure at the time of the change (percent, 0–100). */
  contextPct: number;
}

/**
 * SSE event emitted when the active LLM model or provider changes.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseModelChanged {
  /** Discriminator. Always `'model_changed'`. */
  type: 'model_changed';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Machine-readable provider identifier. */
  provider: string;
  /** Human-readable provider name. */
  providerName: string;
  /** Model name/identifier. */
  model: string;
}

/**
 * SSE event emitted when context pressure drops below the trigger threshold
 * (pressure lifted).
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SsePressureLifted {
  /** Discriminator. Always `'pressure_lifted'`. */
  type: 'pressure_lifted';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Pressure percentage before lifting (percent, 0–100). */
  beforePct: number;
  /** Pressure percentage after lifting (percent, 0–100). */
  afterPct: number;
}

/**
 * SSE event emitted when a checkpoint is persisted to the store.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCheckpointPersisted {
  /** Discriminator. Always `'checkpoint_persisted'`. */
  type: 'checkpoint_persisted';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Unique checkpoint identifier. */
  checkpointId: string;
  /** Total token count in the session at persistence time (tokens). */
  sessionTokens: number;
}

/**
 * SSE event emitted when recall results are injected into the context window.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseRecallInject {
  /** Discriminator. Always `'recall_inject'`. */
  type: 'recall_inject';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** The recall query string used. */
  query: string;
  /** Number of chunks retrieved and injected. */
  chunks: number;
  /** Total tokens injected (tokens). */
  tokens: number;
}

/**
 * SSE event emitted when anchor messages are updated.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseAnchorsUpdated {
  /** Discriminator. Always `'anchors_updated'`. */
  type: 'anchors_updated';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Total number of anchor messages. */
  count: number;
  /** Number of anchor messages that are pinned. */
  pinned: number;
}

/**
 * SSE event emitted when a configuration value is updated.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseConfigUpdated {
  /** Discriminator. Always `'config_updated'`. */
  type: 'config_updated';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Configuration key that was changed. */
  key: string;
  /** New value for the configuration key. */
  value: unknown;
}

/**
 * SSE event emitted when a configuration preset is applied.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseConfigPreset {
  /** Discriminator. Always `'config_preset'`. */
  type: 'config_preset';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Name of the preset that was applied. */
  preset: string;
}

/**
 * SSE event emitted when crew agent presence changes (agents joining/leaving).
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCrewPresenceChanged {
  /** Discriminator. Always `'crew_presence_changed'`. */
  type: 'crew_presence_changed';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Number of currently active crew agents. */
  activeAgents: number;
  /** Current turn index in the crew round-robin. */
  currentTurn: number;
}

/**
 * SSE event emitted when the crew turn advances to a new agent.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCrewTurnChanged {
  /** Discriminator. Always `'crew_turn_changed'`. */
  type: 'crew_turn_changed';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Zero-based index of the current turn. */
  turnIndex: number;
  /** Name of the agent whose turn it now is. */
  agentName: string;
}

/**
 * SSE event emitted when the multi-armed bandit selects an agent for the next turn.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseCrewBanditChosen {
  /** Discriminator. Always `'crew_bandit_chosen'`. */
  type: 'crew_bandit_chosen';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Name of the agent chosen by the bandit. */
  chosenAgent: string;
  /** Bandit score for the chosen agent (dimensionless utility value). */
  score: number;
  /** Cumulative regret of the bandit policy (dimensionless). */
  regret: number;
}
