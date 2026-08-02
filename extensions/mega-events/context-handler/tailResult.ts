/**
 * context-handler/tailResult.ts — buildTailResult(factory).
 *
 * Extracted from context-handler.ts (delegate-shell split). Constructs the
 * closure that injects the staged recall/memory block as a user-role tail
 * message at any context view-return point, plus optional cache-striping /
 * message-separation prompt reshapes and prefix-stability logging.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { stagedForTail, withRecallTail } from "../recall-tail.js";
import { buildSeparatedPrompt, buildCacheOptimizedPrompt } from "../separated-prompt.js";
import { messageContentText } from "./messageText.js";

/**
 * Build the tail injection closure. Returns undefined when nothing is staged
 * (or the flags are OFF) so the caller falls through to its normal return.
 */
export function buildTailResult(
	runtime: MegaRuntime,
	config: MegaConfig,
	messages: readonly AgentMessage[],
): ((msgs?: readonly AgentMessage[]) => { messages: AgentMessage[] } | undefined) {
	// S53: helper to inject the staged recall/memory block as a user-role
	// tail message at any view-return point. Returns undefined when nothing
	// is staged (or the flag is OFF) so the caller falls through to its
	// normal return. The F3 mirror append (above the gates) runs on the
	// REAL transcript before any view is built, so the injected tail never
	// reaches raw_transcript (PREVENT-PI: append-only, view-only).
	const tailResult = (msgs?: readonly AgentMessage[]) => {
		const base = msgs ?? messages;
		if (!stagedForTail(runtime, config) && !config.messageSeparation && !config.cacheStriping) return undefined;
		let result: AgentMessage[] = stagedForTail(runtime, config)
			? withRecallTail(base, runtime, config)
			: (base as AgentMessage[]);
		if (config.cacheStriping) {
			result = buildCacheOptimizedPrompt(result);
		} else if (config.messageSeparation) {
			result = buildSeparatedPrompt(result);
		}
		// P2.5: log prefix stability (fire-and-forget, non-fatal).
		// tailResult is sync, so use .then().catch() on the dynamic import.
		if (result.length > 1) {
			import("../../../src/cache-stripe-impl.js").then(({ computeStabilityScore }) => {
				const stableScore = computeStabilityScore(
					{ content: messageContentText(result[0] ?? result[0]), chunkId: "prefix", accessCount: 0, lastAccessedAt: 0 },
					result.slice(0, 2).map((m) => ({ content: messageContentText(m), chunkId: "prefix", accessCount: 0, lastAccessedAt: 0 })),
				);
				runtime.logger.info("prefix_stability", {
					stableScore: Number.isFinite(stableScore) ? stableScore : 0,
					prefixMessages: result.length,
					separation: config.messageSeparation ? "v2" : "off",
					striping: config.cacheStriping ? "v3" : "off",
				});
			}).catch(() => {
				// Non-fatal: stability logging is best-effort.
			});
		}
		return { messages: result };
	};
	return tailResult;
}
