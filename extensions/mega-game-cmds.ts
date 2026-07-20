/**
 * mega-game-cmds.ts — /mega-game slash command (S30).
 *
 * Backs the game-mode toggle + theme picker + TUI display mode. All state is
 * the global `game_state` SQLite row (src/store/sqlite/game-state.ts) — local
 * only (PREVENT-PI-004: no network; no guardrails-allow needed because this
 * command touches no fetch/http). All SQL is parameterized (PREVENT-002) and
 * lives in the src/ submodule, not here.
 *
 * Usage:
 *   /mega-game                 print current state
 *   /mega-game on              enable game mode (scoring + level-up + MEGA CACHE)
 *   /mega-game off             disable game mode
 *   /mega-game theme           list available themes
 *   /mega-game theme <id>      set theme by id
 *   /mega-game theme next      cycle to next theme
 *   /mega-game tui full        full TUI widget (bars, stats, flair)
 *   /mega-game tui minimal     one-line TUI widget (level + cache %)
 *   /mega-game achievements     list unlocked achievements
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

/** Format the current state as a human-readable status line set. */
function fmtState(s: GameState): string[] {
  return [
    `[mega-game] game mode: ${s.game_mode_on ? "ON" : "off"}`,
    `  theme: ${s.theme}${s.theme === DEFAULT_THEME ? " (default)" : ""}`,
    `  tui:   ${s.tui_display_mode}`,
  ];
}

/** Register the /mega-game command. */
export function registerGameCommands(pi: ExtensionAPI, runtime: MegaRuntime): void {
  pi.registerCommand("mega-game", {
    description:
      "Game mode toggle + theme picker + TUI display mode. Usage: /mega-game [on|off|theme [id|next]|tui [full|minimal]|achievements]",
    handler: async (args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      const stateDir = runtime.currentStateDir;
      const parts = args.trim().split(/\s+/).filter(Boolean);

      // /mega-game  → print current state.
      if (parts.length === 0) {
        const s = getGameState(stateDir);
        for (const line of fmtState(s)) ctx.ui.notify(line);
        return;
      }

      const sub = parts[0]!;

      // /mega-game achievements — terse list of unlocked (hidden only once unlocked).
      if (sub === "achievements") {
        const rows = listAchievements(stateDir).filter((r) => r.unlocked_at != null);
        ctx.ui.notify(`[mega-game] achievements unlocked (${rows.length}/9):`);
        for (const r of rows) {
          ctx.ui.notify(`  ${r.icon ?? ""} ${r.title}`);
        }
        return;
      }

      // /mega-game on|off
      if (sub === "on" || sub === "off") {
        const s = setGameState({ game_mode_on: sub === "on" }, stateDir);
        runtime.bumpGameState();
        ctx.ui.notify(`[mega-game] game mode ${s.game_mode_on ? "ON" : "off"}`);
        return;
      }

      // /mega-game theme [id|next]
      if (sub === "theme") {
        if (parts.length === 1) {
          // list themes
          ctx.ui.notify("[mega-game] themes:");
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
          ctx.ui.notify(`[mega-game] unknown theme "${arg}". Valid: ${THEME_IDS.join(", ")}`);
          return;
        }
        const s = setGameState({ theme: id }, stateDir);
        runtime.bumpGameState();
        ctx.ui.notify(`[mega-game] theme → ${s.theme} (${getTheme(s.theme)?.label ?? ""})`);
        return;
      }

      // /mega-game tui full|minimal
      if (sub === "tui") {
        const arg = parts[1];
        if (arg !== "full" && arg !== "minimal") {
          ctx.ui.notify(`[mega-game] usage: /mega-game tui full|minimal`);
          return;
        }
        const s = setGameState({ tui_display_mode: arg }, stateDir);
        runtime.bumpGameState();
        ctx.ui.notify(`[mega-game] tui → ${s.tui_display_mode}`);
        return;
      }

      ctx.ui.notify(
        `[mega-game] usage: /mega-game [on|off|theme [id|next]|tui [full|minimal]|achievements]`,
      );
    },
  });
}
