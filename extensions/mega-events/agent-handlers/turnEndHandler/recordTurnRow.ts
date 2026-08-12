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
import { ensureConversationIdFor, recordTurnWrite } from "../../../mega-turn-store.js";
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
		recordTurnWrite(
			config,
			{
				conversationId: convId,
				sessionId: runtime.rt.sessionId,
				turnIndex: event.turnIndex,
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
		// DuplicateTurnError: the turn was already persisted (the same turnIndex
		// was written by an earlier code path — a double-write race). This is a
		// SUCCESS, not a failure: the turn IS in turns.db. Emit turn_written with
		// duplicate:true so events.log stops showing 289 false "turn_write_failed"
		// entries (which made the Turns tab + context engine look broken).
		// Uses the same message-pattern idiom as write.ts's UNIQUE constraint guard
		// (no new import; DuplicateTurnError isn't re-exported through mega-turn-store
		// and the append-only invariant forbids UPDATE/UPSERT in the store layer).
		if (e instanceof Error && /Duplicate turn:/.test(e.message)) {
			runtime.dashboard.event("turn_written", {
				turnIndex: event.turnIndex,
				pressureBand: runtime.pressureBand ?? null,
				turnsDbEnabled: config.turnsDbEnabled,
				duplicate: true,
			});
			return;
		}
		runtime.dashboard.event("turn_write_failed", {
			turnIndex: event.turnIndex,
			turnsDbEnabled: config.turnsDbEnabled,
			error: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : undefined,
		});
	}
}
