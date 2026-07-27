/**
 * status.ts — extracted `MegaRuntime.setStatus()`: the runtime status-key text
 * mirrored to pi's status line and the dashboard. Same thin-delegate pattern
 * as the other runtime.ts extractions.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATUS_KEY } from "./helpers.js";

// ---------------------------------------------------------------------- types

/** The slice of `MegaRuntime` setStatus writes (the dashboard status text). */
export interface SetStatusContext {
	statusKey: string | undefined;
}

// ------------------------------------------------------------------ setStatus

export function setStatusImpl(
	self: SetStatusContext,
	ctx: ExtensionContext,
	text: string | undefined,
): void {
	self.statusKey = text;
	ctx.ui.setStatus(STATUS_KEY, text);
}
