/**
 * mega-game-cmds.ts — /mega-compact-settings slash command (S30; renamed in v0.8.x).
 *
 * Backs the game-mode toggle + theme picker + TUI display mode. All state is
 * the global `game_state` SQLite row (src/store/sqlite/game-state.ts) — local
 * only (PREVENT-PI-004: no network; no guardrails-allow needed because this
 * command touches no fetch/http). All SQL is parameterized (PREVENT-002) and
 * lives in the src/ submodule, not here.
 *
 * The primary command is /mega-compact-settings. /mega-game is retained as a
 * backward-compat alias (same handler) so existing muscle memory + docs keep
 * working.
 *
 * Usage:
 *   /mega-compact-settings                 print current state
 *   /mega-compact-settings on              enable game mode (scoring + level-up + MEGA CACHE)
 *   /mega-compact-settings off             disable game mode
 *   /mega-compact-settings theme           list available themes
 *   /mega-compact-settings theme <id>      set theme by id
 *   /mega-compact-settings theme next      cycle to next theme
 *   /mega-compact-settings tui full        full TUI widget (bars, stats, flair)
 *   /mega-compact-settings tui minimal     one-line TUI widget (level + cache %)
 *   /mega-compact-settings achievements      list unlocked achievements
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "./mega-runtime.js";
import {
  getGameState,
  setGameState,
  type GameState,
} from "../src/store/sqlite.js";
import { listAchievements } from "../src/store/sqlite/game-achievements.js";
import { THEMES, THEME_IDS, getTheme, isValidTheme, nextTheme, DEFAULT_THEME } from "../src/config/themes.js";

/** Notify/usage tag + command name. Primary surface is /mega-compact-settings. */
const TAG = "mega-compact-settings";

/** Format the current state as a human-readable status line set. */
function fmtState(s: GameState): string[] {
  return [
    `[${TAG}] game mode: ${s.game_mode_on ? "ON" : "off"}`,
    `  theme: ${s.theme}${s.theme === DEFAULT_THEME ? " (default)" : ""}`,
    `  tui:   ${s.tui_display_mode}`,
  ];
}

/** Shared handler for /mega-compact-settings (primary) + /mega-game (alias). */
async function handleSettings(
  args: string,
  ctx: ExtensionContext,
  runtime: MegaRuntime,
): Promise<void> {
  runtime.bindRepo(ctx.cwd);
  const stateDir = runtime.currentStateDir;
  const parts = args.trim().split(/\s+/).filter(Boolean);

  // bare  → print current state.
  if (parts.length === 0) {
    const s = getGameState(stateDir);
    for (const line of fmtState(s)) ctx.ui.notify(line);
    return;
  }

  const sub = parts[0]!;

  // achievements — terse list of unlocked (hidden only once unlocked).
  if (sub === "achievements") {
    const rows = listAchievements(stateDir).filter((r) => r.unlocked_at != null);
    ctx.ui.notify(`[${TAG}] achievements unlocked (${rows.length}/9):`);
    for (const r of rows) {
      ctx.ui.notify(`  ${r.icon ?? ""} ${r.title}`);
    }
    return;
  }

  // on|off
  if (sub === "on" || sub === "off") {
    const s = setGameState({ game_mode_on: sub === "on" }, stateDir);
    runtime.bumpGameState();
    ctx.ui.notify(`[${TAG}] game mode ${s.game_mode_on ? "ON" : "off"}`);
    return;
  }

  // theme [id|next]
  if (sub === "theme") {
    if (parts.length === 1) {
      // list themes
      ctx.ui.notify(`[${TAG}] themes:`);
      for (const t of THEMES) {
        ctx.ui.notify(`  ${t.id.padEnd(14)} ${t.label}`);
      }
      return;
    }
    const arg = parts[1]!;
    let id: string;
    if (arg === "next") {
      id = nextTheme(getGameState(stateDir).theme);
    } else if (isValidTheme(arg)) {
      id = arg;
    } else {
      ctx.ui.notify(`[${TAG}] unknown theme "${arg}". Valid: ${THEME_IDS.join(", ")}`);
      return;
    }
    const s = setGameState({ theme: id }, stateDir);
    runtime.bumpGameState();
    ctx.ui.notify(`[${TAG}] theme → ${s.theme} (${getTheme(s.theme)?.label ?? ""})`);
    return;
  }

  // tui full|minimal
  if (sub === "tui") {
    const arg = parts[1];
    if (arg !== "full" && arg !== "minimal") {
      ctx.ui.notify(`[${TAG}] usage: /${TAG} tui full|minimal`);
      return;
    }
    const s = setGameState({ tui_display_mode: arg }, stateDir);
    runtime.bumpGameState();
    ctx.ui.notify(`[${TAG}] tui → ${s.tui_display_mode}`);
    return;
  }

  ctx.ui.notify(
    `[${TAG}] usage: /${TAG} [on|off|theme [id|next]|tui [full|minimal]|achievements]`,
  );
}

/** Register /mega-compact-settings (primary) + /mega-game (backward-compat alias). */
export function registerGameCommands(pi: ExtensionAPI, runtime: MegaRuntime): void {
  const description =
    "Game mode toggle + theme picker + TUI display mode. Usage: /mega-compact-settings [on|off|theme [id|next]|tui [full|minimal]|achievements]";
  const handler = (args: string, ctx: ExtensionContext) => handleSettings(args, ctx, runtime);

  // Primary command (renamed in v0.8.x from /mega-game).
  pi.registerCommand("mega-compact-settings", { description, handler });
  // Backward-compat alias: /mega-game still resolves to the same settings UI.
  pi.registerCommand("mega-game", {
    description: "(alias for /mega-compact-settings) " + description,
    handler,
  });
}
