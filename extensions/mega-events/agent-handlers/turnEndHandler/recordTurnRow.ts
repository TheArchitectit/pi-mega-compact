/**
 * turnEndHandler/recordTurnRow.ts — S43 per-turn tracking.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Records one turn row with the cached metrics
 * so the turn layer is queryable + forkable. Best-effort + non-fatal: a write
 * failure never breaks the agent loop.
 */
import type { MegaRuntime } from "../../../mega-runtime.js";
import type { MegaConfig } from "../../../mega-config.js";
import { ensureConversationIdFor, recordTurnWrite, turnReaderFor } from "../../../mega-turn-store.js";
import type { TurnEndEvent } from "./event.js";

/** S43: record one turn row with the cached metrics. Best-effort + non-fatal. */
export function recordTurnRow(
	event: TurnEndEvent,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// S43 (per-turn tracking): record one turn row with the cached metrics so
	// the turn layer is queryable + forkable. Best-effort + non-fatal: a write
	// failure never breaks the agent loop. The catch logs the error (structured
	// JSON line to events.log) so a recurring turn-write failure is diagnosable
	// instead of silently producing a blank Turns tab.
	try {
		const convId = ensureConversationIdFor(
			config,
			runtime.rt.sessionId,
			runtime.currentStateDir,
		);
		// S49R: store the conversation-monotonic index (MAX+1) instead of the
		// per-session event.turnIndex, which restarts at 0 on resume and would
		// collide with UNIQUE(conversation_id, turn_index). Carry the session
		// counter as sessionTurnIndex for the raw_transcript metrics join.
		const turnIndex = turnReaderFor(runtime.currentStateDir).nextTurnIndexFor(convId);
		recordTurnWrite(
			config,
			{
				conversationId: convId,
				sessionId: runtime.rt.sessionId,
				turnIndex,
				sessionTurnIndex: event.turnIndex,
				role: (event as { role?: string }).role ?? "assistant",
				endedAt: Date.now(),
				startedAt: undefined,
				ctxTokens: runtime.lastCtxTokens ?? undefined,
				ctxPercent: runtime.lastCtxPercent ?? undefined,
				pressureBand: runtime.pressureBand ?? undefined,
				modelId: runtime.currentModel?.modelId ?? undefined,
			},
			runtime.currentStateDir,
		);
		runtime.dashboard.event("turn_written", {
			turnIndex: event.turnIndex,
			conversationId: convId,
			pressureBand: runtime.pressureBand ?? null,
			turnsDbEnabled: config.turnsDbEnabled,
		});
	} catch (e) {
		runtime.dashboard.event("turn_write_failed", {
			turnIndex: event.turnIndex,
			turnsDbEnabled: config.turnsDbEnabled,
			error: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : undefined,
		});
	}
}
