/**
 * agent-handlers/turnEndHandler.ts — the pi `turn_end` handler body.
 *
 * Delegate-shell (extensions split): extracts each concern into a helper in
 * ./turnEndHandler/* so every source file stays under the extensions limit.
 * The heavy sections live in sibling files: recordTurnRow (S43 persistence),
 * gameScoring (S33/S35), memoryReview (S20/S24), lengthStop (S28), errorRetry
 * (S38/R1-R11 safety net), cacheStripe (P3.5), and contextHealth (v0.12).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import type { TurnEndEvent } from "./turnEndHandler/event.js";
import { recordTurnRow } from "./turnEndHandler/recordTurnRow.js";
import { gameScoring } from "./turnEndHandler/gameScoring.js";
import { memoryReview } from "./turnEndHandler/memoryReview.js";
import { lengthStop } from "./turnEndHandler/lengthStop.js";
import { errorRetry } from "./turnEndHandler/errorRetry.js";
import { cacheStripe } from "./turnEndHandler/cacheStripe.js";
import { contextHealth } from "./turnEndHandler/contextHealth.js";

/** Handle the `turn_end` pi event. Non-fatal end-to-end. */
export async function handleTurnEnd(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): Promise<void> {
	runtime.dashboard.event("turn_end", { turnIndex: event.turnIndex });
	runtime.snapshot(ctx);
	runtime.lastErrorCategory = null;

	// S53: consume staged recall blocks ONLY if they were actually injected
	// into a view this turn. If no context event fired (edge: turn ended
	// before any LLM call), recallInjectedThisTurn stays false and the blocks
	// remain staged for the next turn's first context event.
	if (config.recallTailInject && runtime.rt.recallInjectedThisTurn) {
		runtime.pendingRecallBlock = undefined;
		runtime.pendingMemoryRecallBlock = undefined;
		runtime.rt.recallInjectedThisTurn = false;
	}

	// S43 (per-turn tracking): record one turn row. Best-effort + non-fatal.
	recordTurnRow(event, runtime, config);

	// S33/S35: game-mode scoring + achievements. Best-effort + non-fatal (G6).
	gameScoring(event, ctx, runtime);

	// S20+S24: auto-review the conversation, persist durable memories.
	await memoryReview(ctx, runtime, config);

	// S28: detect max-output-token truncation, arm the agent_end nudge.
	lengthStop(event, runtime, config);

	// S38/R1-R11: broader error-retry safety net. Non-fatal end-to-end.
	await errorRetry(event, ctx, pi, runtime, config);

	// P3.5: topic-shift cache stripe refresh. Best-effort + non-fatal.
	cacheStripe(event, runtime, config);

	// v0.12: context-health score + mitigation. Non-fatal.
	contextHealth(event, ctx, runtime, config);
}
