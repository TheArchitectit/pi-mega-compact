/**
 * api-contracts/game.ts — Game mode and mega-game contracts.
 *
 * Contains: GameConfig, GameStateResponse, GameRitualStage,
 * SseGameRitualStart, SseGameRitualStage, SseGameRitualEnd,
 * SseGameModeChanged, SseGameRender.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/game-state ──────────────────────────────────────────────────────

export interface GameConfig {
  enabled: boolean;
  /** Visual theme for the TUI game renderer. */
  theme: 'moss' | 'ocean' | 'ember' | 'slate' | 'neon' | 'mono';
  /** How much of the TUI game UI to show. */
  displayMode: 'full' | 'minimal';
}

export interface GameStateResponse {
  config: GameConfig;
  /** Active ritual session, if one is in progress. */
  activeRitual: {
    sessionId: string;
    stageIndex: number;
    startedAt: string;
    elapsed: number;
  } | null;
}

export interface GameRitualStage {
  index: number;
  name: string;
  durationMs: number;
  status: 'pending' | 'active' | 'done' | 'cancelled';
}

// ─── Game SSE Events ──────────────────────────────────────────────────────

export interface SseGameRitualStart {
  type: 'game_ritual_start';
  ts: string;
  sessionId: string;
  stages: GameRitualStage[];
}

export interface SseGameRitualStage {
  type: 'game_ritual_stage';
  ts: string;
  sessionId: string;
  stageIndex: number;
  stageName: string;
}

export interface SseGameRitualEnd {
  type: 'game_ritual_end';
  ts: string;
  sessionId: string;
  success: boolean;
}

export interface SseGameModeChanged {
  type: 'game_mode_changed';
  ts: string;
  config: GameConfig;
}

export interface SseGameRender {
  type: 'game_render';
  ts: string;
  frame: string;
}
