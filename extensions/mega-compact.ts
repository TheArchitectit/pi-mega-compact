/**
 * pi-mega-compact — layered, local, vector-backed context compressor.
 *
 * Extension entry. Wires the pi-agnostic Trident engine (src/) into pi's
 * extension lifecycle.
 *
 * Design constraints (from RESEARCH.md):
 *  - No network at runtime (PREVENT-PI-004).
 *  - pi Message has no system-role entry (PREVENT-PI-003); inject compacted
 *    context via `before_agent_start` systemPrompt (Sprint 4), or a
 *    `compactionSummary` message so it renders like native compaction.
 *  - Message drops must preserve an anchor floor (PREVENT-PI-001) and never
 *    split a toolCall/toolResult pair (PREVENT-PI-002).
 *
 * The extension is split into focused modules under extensions/mega-*.ts:
 *   - mega-config.ts        tiers, env helpers, loadConfig, per-repo scoping
 *   - mega-dashboard.ts     live snapshot writer (dashboard.json / events.log)
 *   - mega-runtime.ts       shared live state (MegaRuntime) + widget + model capture
 *   - mega-pipeline.ts      runCompact (Trident+persist) + doRecall (Layer 5)
 *   - mega-commands.ts      data/inspection slash commands
 *   - mega-game-cmds.ts     /mega-game toggle + theme + TUI display mode
 *   - mega-dashboard-cmds.ts  localhost dashboard server lifecycle commands
 *   - mega-events.ts        pi lifecycle event handlers
 *
 * This file is the thin wiring layer: it owns the default export, constructs
 * the runtime, and registers handlers/commands. Behavior is unchanged.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./mega-config.js";
import { MegaRuntime } from "./mega-runtime.js";
import { registerEventHandlers } from "./mega-events.js";
import { registerCommands } from "./mega-commands.js";
import { registerDashboardCommands } from "./mega-dashboard-cmds.js";
import { registerConflictCommands } from "./mega-conflict-cmds.js";
import { registerDbCommands } from "./mega-db-cmds.js";
import { registerGameCommands } from "./mega-game-cmds.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const runtime = new MegaRuntime(config);
  registerEventHandlers(pi, runtime, config);
  registerCommands(pi, runtime, config);
  registerDashboardCommands(pi, runtime);
  registerConflictCommands(pi, runtime);
  registerDbCommands(pi, runtime);
  registerGameCommands(pi, runtime);
}
