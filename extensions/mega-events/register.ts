/**
 * mega-events/register.ts — top-level event handler registration.
 *
 * Exports `lastRuntime` (DIAG accessor for the test harness) and
 * `registerEventHandlers` which delegates to the focused sub-registration
 * functions in session/agent/context/compact handlers.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";
import { registerSessionHandlers } from "./session-handlers.js";
import { registerAgentHandlers } from "./agent-handlers.js";
import { registerContextHandler } from "./context-handler.js";
import { registerCompactHandlers } from "./compact-handlers.js";
import { registerPerfHandler } from "./perf-handler.js";
import { registerVectorCortexRender } from "../mega-context/vector-cortex.js";

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
	// VC5B: wire the render+validate seam into the before_agent_start lifecycle.
	// Registered FIRST so its no-op return (no render input on ctx) doesn't
	// clobber a systemPrompt that a later before_agent_start handler (e.g. the
	// legacy recall prepend in session-handlers) returns. When VC5B does
	// prepend, it returns a new systemPrompt; the later handlers run on the
	// recallTailInject=ON path and return undefined, so VC5B's return survives.
	// The _ctx param is unused by the seam; pass empty for the registered seam.
	try {
		registerVectorCortexRender(pi, undefined as unknown as ExtensionContext, (event, fields) => {
			try { runtime.appendEvent(event, fields); } catch { /* non-fatal */ }
		});
	} catch { /* non-fatal: VC5B registration never breaks startup */ }
	// ---- Session lifecycle (state reset points) -------------------------------
	registerSessionHandlers(pi, runtime, config);
	registerAgentHandlers(pi, runtime, config);
	registerContextHandler(pi, runtime, config);
	registerCompactHandlers(pi, runtime, config);
	registerPerfHandler(pi, runtime);
}
