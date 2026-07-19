/**
 * mega-events/register.ts — top-level event handler registration.
 *
 * Exports `lastRuntime` (DIAG accessor for the test harness) and
 * `registerEventHandlers` which delegates to the focused sub-registration
 * functions in session/agent/context/compact handlers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";
import { registerSessionHandlers } from "./session-handlers.js";
import { registerAgentHandlers } from "./agent-handlers.js";
import { registerContextHandler } from "./context-handler.js";
import { registerCompactHandlers } from "./compact-handlers.js";

/**
 * DIAG accessor for the headless test harness: the most recently constructed
 * MegaRuntime, so a test that loads the compiled extension via its default
 * export can read diag counters (diagLiveTrimFires / diagBeforeCompactFires /
 * diagBeforeCompactSupplied / diagAgentEndIdle) after firing synthetic events.
 * No-op in production — nothing reads this outside tests.
 */
export let lastRuntime: MegaRuntime | undefined;

/** Register all pi lifecycle event handlers. */
export function registerEventHandlers(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	lastRuntime = runtime;
	// ---- Session lifecycle (state reset points) -------------------------------
	registerSessionHandlers(pi, runtime, config);
	registerAgentHandlers(pi, runtime, config);
	registerContextHandler(pi, runtime, config);
	registerCompactHandlers(pi, runtime, config);
}
