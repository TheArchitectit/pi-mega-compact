/**
 * turnEndHandler/memoryReview.ts — S20+S24 memory auto-review.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Auto-reviews the conversation and persists
 * durable memories. Best-effort + non-fatal: a review failure must never break
 * the agent loop. Debounced by the pressure-adjusted interval.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../../mega-runtime.js";
import { runMemoryReview } from "../../../mega-pipeline.js";
import { memoryReviewCadence, type MegaConfig } from "../../../mega-config.js";

/** S20+S24: auto-review the conversation and persist durable memories. */
export async function memoryReview(
	ctx: ExtensionContext,
	runtime: MegaRuntime,
	config: MegaConfig,
): Promise<void> {
	// S20+S24: auto-review the conversation and persist durable memories. The
	// review cadence scales with pressure (memoryReviewCadence): as context
	// fills, the conversation is reviewed more often so memories keep pace with
	// faster churn. Best-effort + non-fatal: a review failure must never break
	// the agent loop. Debounced by the pressure-adjusted interval.
	if (config.memoryAutoReview && runtime.currentTurn > 0) {
		const cadence = memoryReviewCadence(
			runtime.pressureBand,
			config.memoryReviewInterval,
		);
		if (runtime.currentTurn % cadence === 0) {
			// S20+S24: review the conversation and persist durable memories. The
			// cadence scales with pressure (memoryReviewCadence): as context fills,
			// the conversation is reviewed more often so memories keep pace with
			// faster churn. Shared runMemoryReview body (also used on compact).
			const entries = ctx.sessionManager.getEntries();
			const view = runtime.engineView(
				entries.flatMap((e: any) => (e.message ? [e.message] : [])),
			);
			await runMemoryReview(runtime, view, "turn");
		}
	}
}
