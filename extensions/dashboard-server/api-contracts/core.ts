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
 * SSE event emitted on a recall pass when HyDE was considered (H1). Streamed
 * via `GET /api/events`. Mirrors the metrics carried up from the recall core's
 * `HydeInvocationInfo`.
 */
export interface SseHydeExecuted {
  /** Discriminator. Always `'hyde_executed'`. */
  type: 'hyde_executed';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Session identifier the recall ran in. */
  sessionId: string;
  /** True when HyDE ran (hypothetical doc generated + embedded + searched). */
  ran: boolean;
  /** True when HyDE was considered but explicitly skipped. */
  skipped: boolean;
  /** Human-readable reason: "ran" | "disabled" | "no-llm" | "generation-failed". */
  reason: string;
  /** The hypothetical answer document the LLM produced (truncated). */
  hypotheticalDoc: string;
  /** ms spent generating + embedding the hypothetical doc (0 when skipped). */
  generationMs: number;
  /** Hit count from the raw-query search before fusion. */
  rawHitCount: number;
  /** Hit count from the hypothetical-doc search before fusion. */
  hydeHitCount: number;
  /** Hit count of the RRF-fused result actually injected. */
  fusedHitCount: number;
  /** Lift = fusedHitCount / max(1, rawHitCount). */
  lift: number;
}

/**
 * SSE event emitted per recall pass with the recall-quality metrics (H1).
 * Streamed via `GET /api/events`.
 */
export interface SseRecallMetrics {
  /** Discriminator. Always `'recall_metrics'`. */
  type: 'recall_metrics';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Session identifier the recall ran in. */
  sessionId: string;
  /** Number of hits injected for the turn. */
  hitCount: number;
  /** Weighted composite recall-quality score (0–1). */
  score: number;
  /** Whether the recall quality passed its thresholds. */
  pass: boolean;
  /** Relevance breakdown (0–1). */
  relevance: number;
  /** Coverage breakdown (0–1). */
  coverage: number;
  /** Diversity breakdown (0–1). */
  diversity: number;
  /** Specificity breakdown (0–1). */
  specificity: number;
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

/**
 * SSE event appened to events.log by `appendTokenSample`
 * (src/store/sqlite/global-index.ts) on every material snapshot. The existing
 * `GET /api/events` SSE handler tails events.log line-by-line, so these
 * `session_sample` lines stream to the dashboard client for free
 * (real-time chart updates between the 2s polls in the Sessions tab).
 *
 * Wire shape mirrors {@link SseCompactStart} etc. with `ts` (ISO 8601 string)
 * plus `type` (`'session_sample'`) and the per-session payload.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseSessionSample {
  /** Discriminator. Always `'session_sample'`. */
  type: 'session_sample';
  /** ISO 8601 timestamp of the sample (coincides with the token_samples row `ts`). */
  ts: string;
  /** Session identifier the sample belongs to. */
  sessionId: string;
  /** Context window token count at this sample (tokens). */
  tokens: number;
  /** Context pressure percentage (0–100). */
  percent: number;
}
