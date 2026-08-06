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
import { computeContentDigest } from "../../../src/dedup/digest.js";

// P2.5: per-runtime cross-turn prompt-prefix footprints for stable-prefix
// measurement. WeakMap keyed by MegaRuntime so the entry dies with the runtime
// (same lifecycle as a session boundary in practice — a new session re-creates
// the pipeline over the same runtime, but the prior turn's fingerprints must
// still be visible for cross-turn compare; a fresh runtime has an empty map and
// the sessionId guard below blocks cross-session compare).
type TurnPrefix = { sessionId: string; turn: number; fingerprints: string[] };
const lastTurnPrefix = new WeakMap<MegaRuntime, TurnPrefix>();

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
		// P2.5: log cross-turn stable-prefix length (cache-hit proxy). After the
		// prompt is built (separated or cache-optimized), fingerprint each leading
		// message and count how many are byte-identical to the previous turn's
		// prompt, in order. A high stablePrefix = the provider KV-cache prefix is
		// re-used (cache hit). Fire-and-forget + non-fatal.
		//
		// tailResult may run several times per turn (gate return / replay /
		// debounce / live-trim), so the sessionId+turn guard measures once per
		// turn — compare against the PREVIOUS turn's stored footprint, then store
		// this turn's for the next comparison. Cross-session compares are skipped
		// via the stored sessionId check (belt-and-suspenders; the WeakMap entry
		// is scoped to this runtime, which owns the session).
		if (result.length > 1) {
			try {
				const sessionId = runtime.rt.sessionId;
				const turn = runtime.currentTurn;
				const prev = lastTurnPrefix.get(runtime);
				const isNewTurn =
					!prev || prev.sessionId !== sessionId || prev.turn !== turn;
				if (isNewTurn) {
					const fingerprints = result.map((m) =>
						// Role prefix disambiguates identical text across variants
						// (roles are a fixed enum — no realistic fingerprint collision).
						computeContentDigest(`${m.role}|${messageContentText(m)}`).contentHash,
					);
					let stablePrefix = 0;
					if (prev && prev.sessionId === sessionId) {
						for (let i = 0; i < fingerprints.length; i++) {
							if (
								i >= prev.fingerprints.length ||
								prev.fingerprints[i] !== fingerprints[i]
							) {
								break;
							}
							stablePrefix++;
						}
					}
					lastTurnPrefix.set(runtime, { sessionId, turn, fingerprints });
					// PC-C: write to the always-on monitoring events log (appendEvent),
					// not the debug-gated runtime logger (mega-compact.log), so the
					// dashboard /api/prefix-stability endpoint can read this per-turn
					// stable-prefix ratio from ctx.eventsPath. Same field shape.
					runtime.appendEvent("prefix_stability", {
						stablePrefix,
						totalMessages: result.length,
						separation: config.messageSeparation ? "v2" : "off",
						striping: config.cacheStriping ? "v3" : "off",
					});
				}
			} catch {
				// Non-fatal: stability logging is best-effort.
			}
		}
		return { messages: result };
	};
	return tailResult;
}
