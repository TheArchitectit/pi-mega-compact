/**
 * game-state.ts — `game_state` table: the global game-mode toggle state (S30).
 *
 * Single row (id=1) holding: game_mode_on (bool), theme (one of THEME_IDS),
 * tui_display_mode ('full'|'minimal'). Global — one choice across all repos.
 * Survives restarts; editable from /mega-game (TUI) or the dashboard panel
 * (S32), both reading/writing this same row so they stay in sync.
 *
 * PREVENT-PI-004: local SQLite only, zero network.
 * PREVENT-002: all SQL parameterized (@param / ? placeholders, no concat).
 * Pi-agnostic: no pi runtime types (mirrors meta.ts / session-state.ts).
 */
import { DatabaseSync } from "node:sqlite";
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";
import { DEFAULT_THEME, isValidTheme } from "../../config/themes.js";

/** The persisted game-mode state. `theme` is always a valid THEME_IDS member
 *  (callers may assume the invariant; setGameState validates). */
export interface GameState {
  game_mode_on: boolean;
  theme: string;
  tui_display_mode: "full" | "minimal";
}

export const DEFAULT_GAME_STATE: GameState = {
  game_mode_on: false,
  theme: DEFAULT_THEME,
  tui_display_mode: "full",
};

/** Read the global game-mode state. Returns DEFAULT_GAME_STATE if the row is
 *  absent (fresh install) or any column is unexpectedly null/invalid — never
 *  throws, so the widget / command can call it on every render safely. */
export function getGameState(stateDir: string = getStateDir()): GameState {
  const db = openStore(stateDir);
  return getGameStateRow(db);
}

/** Read the game state from an already-open connection (used by callers that
 *  hold a db handle, e.g. within a transaction). Same defensive fallback. */
export function getGameStateRow(db: DatabaseSync): GameState {
  const row = db.prepare(
    "SELECT game_mode_on, theme, tui_display_mode FROM game_state WHERE id = 1",
  ).get() as { game_mode_on: number; theme: string; tui_display_mode: string } | undefined;
  if (!row) return { ...DEFAULT_GAME_STATE };
  const mode: "full" | "minimal" =
    row.tui_display_mode === "minimal" ? "minimal" : "full";
  return {
    game_mode_on: row.game_mode_on === 1,
    theme: isValidTheme(row.theme) ? row.theme : DEFAULT_THEME,
    tui_display_mode: mode,
  };
}

/** A partial update to the game state (omit fields you don't want to change). */
export type GameStatePatch = Partial<GameState>;

/** Upsert the game state row, applying `patch` on top of the current values.
 *  Validates `theme` (keeps previous on an unknown id) and `tui_display_mode`
 *  (coerces to 'full' on anything but 'minimal'). Parameterized (PREVENT-002).
 *  Returns the post-write state. */
export function setGameState(patch: GameStatePatch, stateDir: string = getStateDir()): GameState {
  const db = openStore(stateDir);
  return setGameStateRow(db, patch);
}

/** Upsert on an already-open connection (for transactional callers). */
export function setGameStateRow(db: DatabaseSync, patch: GameStatePatch): GameState {
  const cur = getGameStateRow(db);
  const next: GameState = {
    game_mode_on: patch.game_mode_on ?? cur.game_mode_on,
    theme: patch.theme != null && isValidTheme(patch.theme) ? patch.theme : cur.theme,
    tui_display_mode: patch.tui_display_mode ?? cur.tui_display_mode,
  };
  // Single-row upsert (id=1). INSERT ... ON CONFLICT(id) DO UPDATE keeps it
  // one row whether the table is fresh or already seeded.
  db.prepare(
    `INSERT INTO game_state (id, game_mode_on, theme, tui_display_mode)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       game_mode_on = excluded.game_mode_on,
       theme = excluded.theme,
       tui_display_mode = excluded.tui_display_mode`,
  ).run(next.game_mode_on ? 1 : 0, next.theme, next.tui_display_mode);
  return next;
}
