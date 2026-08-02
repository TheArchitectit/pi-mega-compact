/**
 * mega-commands.ts — the data/inspection slash commands.
 *
 * Delegate-shell (extensions split): registers the 8 user-facing commands that
 * operate on the local vector store and live runtime state. Implementation is
 * split by group into ./mega-commands/:
 *  - dataCommands.ts     /mega-compact, /mega-recall, /mega-status
 *  - historyCommands.ts  /mega-restore, /mega-history, /mega-view, /mega-help
 *  - setupCommand.ts     /mega-setup
 *  - helpers.ts          findCheckpoint + checkRecallQuality
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "./mega-runtime.js";
import type { MegaConfig } from "./mega-config.js";
import { registerDataCommands } from "./mega-commands/dataCommands.js";
import { registerHistoryCommands } from "./mega-commands/historyCommands.js";
import { registerSetupCommand } from "./mega-commands/setupCommand.js";

export { findCheckpoint } from "./mega-commands/helpers.js";

/** Register all data/inspection commands. */
export function registerCommands(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	registerDataCommands(pi, runtime, config);
	registerHistoryCommands(pi, runtime);
	registerSetupCommand(pi);

	// NOTE: /mega-tier was removed in S24. The tier the user sees is now the LIVE
	// pressure band (low/medium/high/ultra/mega), which climbs automatically as
	// context fills — there is no manual tier to set. See docs/specs/s24-unified-pressure.md.
}
