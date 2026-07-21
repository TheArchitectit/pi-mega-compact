/**
 * api-contracts/game.ts — Game mode and mega-game contracts.
 *
 * Contains: GameConfig, GameStateResponse, GameRitualStage,
 * SseGameRitualStart, SseGameRitualStage, SseGameRitualEnd,
 * SseGameModeChanged, SseGameRender.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/game-state ──────────────────────────────────────────────────────

/**
 * Game mode configuration.
 *
 * Used in `GET /api/game-state` and `PUT /api/game-state` responses, and in
 * the `SseGameModeChanged` SSE event.
 */
export interface GameConfig {
  /** Whether game mode is enabled. */
  enabled: boolean;
  /** Visual theme for the TUI game renderer. */
  theme: 'moss' | 'ocean' | 'ember' | 'slate' | 'neon' | 'mono';
  /** How much of the TUI game UI to show. */
  displayMode: 'full' | 'minimal';
}

/**
 * Response body for `GET /api/game-state` and `PUT /api/game-state`.
 *
 * Reports the current game configuration and any active ritual session.
 */
export interface GameStateResponse {
  /** Current game mode configuration. */
  config: GameConfig;
  /** Active ritual session, if one is in progress. */
  activeRitual: {
    /** Unique ritual session identifier. */
    sessionId: string;
    /** Zero-based index of the current ritual stage. */
    stageIndex: number;
    /** ISO 8601 timestamp when the ritual started. */
    startedAt: string;
    /** Time elapsed since the ritual started (milliseconds). */
    elapsed: number;
  } | null;
}

/**
 * Definition of a single stage in a game ritual.
 *
 * Used in the `SseGameRitualStart` SSE event's `stages` array.
 */
export interface GameRitualStage {
  /** Zero-based stage index in the ritual sequence. */
  index: number;
  /** Human-readable stage name. */
  name: string;
  /** Planned duration of this stage (milliseconds). */
  durationMs: number;
  /**
   * Current status of this stage.
   * Allowed values: `'pending'`, `'active'`, `'done'`, `'cancelled'`.
   */
  status: 'pending' | 'active' | 'done' | 'cancelled';
}

// ─── Game SSE Events ──────────────────────────────────────────────────────

/**
 * SSE event emitted when a game ritual starts.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseGameRitualStart {
  /** Discriminator. Always `'game_ritual_start'`. */
  type: 'game_ritual_start';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Unique ritual session identifier. */
  sessionId: string;
  /** Full list of ritual stages in order. */
  stages: GameRitualStage[];
}

/**
 * SSE event emitted when a game ritual advances to a new stage.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseGameRitualStage {
  /** Discriminator. Always `'game_ritual_stage'`. */
  type: 'game_ritual_stage';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Unique ritual session identifier. */
  sessionId: string;
  /** Zero-based index of the stage that was entered. */
  stageIndex: number;
  /** Name of the stage that was entered. */
  stageName: string;
}

/**
 * SSE event emitted when a game ritual ends.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseGameRitualEnd {
  /** Discriminator. Always `'game_ritual_end'`. */
  type: 'game_ritual_end';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Unique ritual session identifier. */
  sessionId: string;
  /** Whether the ritual completed successfully. */
  success: boolean;
}

/**
 * SSE event emitted when the game mode configuration changes.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseGameModeChanged {
  /** Discriminator. Always `'game_mode_changed'`. */
  type: 'game_mode_changed';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** New game mode configuration. */
  config: GameConfig;
}

/**
 * SSE event emitted when a game render frame is produced.
 *
 * Served via `GET /api/events` (Server-Sent Events stream).
 */
export interface SseGameRender {
  /** Discriminator. Always `'game_render'`. */
  type: 'game_render';
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Serialized render frame content (TUI/ANSI text). */
  frame: string;
}
