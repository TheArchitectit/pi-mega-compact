/**
 * turnEndHandler/cacheStripe.ts — P3.5 topic-shift stripe refresh.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. When MEGACOMPACT_CACHE_STRIPING is ON, embed
 * the current turn, detect topic shift vs. the previous turn, and refresh cache
 * stripe assignments when shifted (or first turn). Best-effort: failures log +
 * continue, never break the agent loop.
 */
import type { MegaRuntime } from "../../../mega-runtime.js";
import type { MegaConfig } from "../../../mega-config.js";
import { defaultEmbedder } from "../../../../src/embedder.js";
import { storeTopicEmbedding, loadTopicEmbedding, detectTopicShift } from "../../separated-prompt.js";
import { refreshStripeAssignments as writeStripeAssignments } from "../../../../src/cache-stripe-impl.js";
import type { TurnEndEvent } from "./event.js";

/** P3.5: topic-shift stripe refresh. Best-effort + non-fatal. */
export function cacheStripe(
	event: TurnEndEvent,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	if (config.cacheStriping) {
		try {
			const stateDir = runtime.currentStateDir;
			const sessionId = runtime.rt.sessionId;
			const currentTurn = event.turnIndex;
			const embedder = defaultEmbedder();

			// (a) Extract text from the assistant's response for topic embedding.
			let textToEmbed = "";
			const msg = event.message;
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if ("text" in part && typeof part.text === "string") {
						textToEmbed += part.text + " ";
					}
				}
			}
			textToEmbed = textToEmbed.trim() || `turn-${currentTurn}`;
			const embedding = new Float32Array(embedder.embed(textToEmbed));
			storeTopicEmbedding(stateDir, sessionId, currentTurn, embedding);

			// (b) Load previous turn's embedding and detect topic shift.
			const prevEmb = currentTurn > 0
				? loadTopicEmbedding(stateDir, sessionId, currentTurn - 1)
				: null;
			const shifted = currentTurn === 0 || detectTopicShift(embedding, prevEmb);

			// (c) If shifted (or first turn), refresh stripe assignments (WRITE path).
			let chunkCount = 0;
			if (shifted) {
				chunkCount = writeStripeAssignments(
					stateDir,
					undefined,
					embedder,
					(detail) => runtime.logger.info("stripe_refresh_detail", {
						detail,
						turnIndex: currentTurn,
					}),
				);
			}

			// (d) Log the refresh outcome.
			runtime.logger.info("stripe_refresh", {
				turnIndex: currentTurn,
				shifted,
				chunkCount,
			});
		} catch {
			/* non-fatal: stripe refresh never breaks the agent loop */
		}
	}
}
