/**
 * turnEndHandler/lengthStop.ts — S28 max-output-token truncation detection.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Detects when event.message.stopReason is
 * 'length' (generation hit max_tokens OUTPUT cap) and arms the agent_end nudge.
 */
import type { MegaRuntime } from "../../../mega-runtime.js";
import type { MegaConfig } from "../../../mega-config.js";
import type { TurnEndEvent } from "./event.js";

/** S28: detect max-output-token truncation and arm the agent_end nudge. */
export function lengthStop(
	event: TurnEndEvent,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// S28: detect max-output-token truncation. event.message.stopReason is the
	// pi-ai StopReason union; 'length' == generation hit max_tokens OUTPUT cap
	// (INPUT-orthogonal to context-window overflow). Arm the agent_end nudge.
	if (
		config.autoContinueLengthStop &&
		event.message.role === "assistant" &&
		event.message.stopReason === "length"
	) {
		runtime.rt.lengthStopPending = true;
		// Phase H: output-error catch — ALSO arm the one-shot force-compact flag so
		// the next compaction gate trips immediately, freeing input headroom for
		// the model's next response. Gated by config.outputErrorCompact (default
		// ON; OFF = byte-identical pre-H — only the S28 auto-continue nudge fires).
		if (config.outputErrorCompact) {
			runtime.rt.forceCompactNextGate = true;
		}
		runtime.dashboard.event("length_stop", { turnIndex: event.turnIndex });
	}
}
