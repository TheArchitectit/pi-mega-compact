/**
 * append-event.ts — extracted `MegaRuntime.appendEvent()`: the structured
 * events.log diagnostics sink. Same context-interface + free-function +
 * thin-delegate pattern as runtime-helpers.ts / effects.ts / game-state.ts.
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------- types

/** The slice of `MegaRuntime` appendEvent reads (the bound repo's state dir). */
export interface AppendEventContext {
	readonly currentStateDir: string;
}

// ---------------------------------------------------------------- appendEvent

/**
 * Append a structured line to the repo's events.log — the always-on
 * diagnostics sink the dashboard live-streams. Unlike the runtime logger
 * (gated by config.debug), this fires in production, so capture failures
 * surface during a real capture even with debugging off. Best-effort +
 * non-fatal.
 */
export function appendEventImpl(
	self: AppendEventContext,
	event: string,
	fields: Record<string, unknown>,
): void {
	try {
		mkdirSync(self.currentStateDir, { recursive: true });
		appendFileSync(
			join(self.currentStateDir, "events.log"),
			JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n",
		);
	} catch {
		/* non-fatal */
	}
}
