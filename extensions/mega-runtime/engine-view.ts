/**
 * engine-view.ts — extracted `MegaRuntime.engineView()`: the pi→engine message
 * adapter passthrough. A one-liner in its own module per the maximal-split
 * convention.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toEngineMessages } from "../../src/adapt.js";

// ------------------------------------------------------------------ engineView

/** Convert the messages pi hands us in the `context` event into the engine view. */
export function engineViewImpl(
	messages: AgentMessage[],
): ReturnType<typeof toEngineMessages> {
	return toEngineMessages(messages);
}
