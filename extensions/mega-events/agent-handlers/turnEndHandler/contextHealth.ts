/**
 * turnEndHandler/contextHealth.ts — v0.12 context-health mitigation.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Computes + persists the health score and
 * acts on mitigation signals (force-compact / prefix-break) here at turn_end,
 * where ctx is in scope. Non-fatal.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../../mega-runtime.js";
import { piCompactWouldNoop } from "../../../mega-pipeline.js";
import type { MegaConfig } from "../../../mega-config.js";
import { handleTurnEndHealth } from "../../health-handler.js";
import type { TurnEndEvent } from "./event.js";

/** v0.12: context-health mitigation. Non-fatal end-to-end. */
export function contextHealth(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// v0.12: Context Health — compute + persist health score. Non-fatal.
	// Mitigation signals are acted on here (ctx is in scope at turn_end).
	const healthSignal = handleTurnEndHealth(event, runtime, config);
	if (healthSignal.forceCompact) {
		runtime.logger?.info("health_mitigate_compact", {
			composite: healthSignal.composite,
			turnIndex: event.turnIndex,
		});
		try {
			// Force a compaction to flush degraded context. Same race-guarded
			// deferred path as the critical-over escape hatch above.
			if (!piCompactWouldNoop(ctx)) {
				ctx.compact();
			}
		} catch {
			/* non-fatal: mitigation never breaks the agent loop */
		}
	}
	if (healthSignal.breakPrefix) {
		runtime.logger?.info("health_mitigate_prefix_break", {
			turnIndex: event.turnIndex,
		});
		// Invalidate the cached trim so the next context event regenerates
		// from scratch — the prefix change forces a cache miss, bypassing
		// the corrupted KV state.
		runtime.trimCache = null;
	}
}
