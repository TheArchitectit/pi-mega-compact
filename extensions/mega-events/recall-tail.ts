/**
 * recall-tail.ts — S53 Recall Tail Injection: append staged recall/memory blocks
 * as a single user-role message at the very tail of the context view, instead
 * of prepending them as part of systemPrompt (the pre-S53 behavior).
 *
 * Key invariants (enforced / tested):
 *  - PREVENT-PI-001/002: append-only at the very tail; never splits a
 *    toolCall/toolResult pair.
 *  - PREVENT-PI-003: user-role message, never system role.
 *  - Turn-scoped pin: staged blocks inject on EVERY context event of the turn
 *    (tool loops); consumed at turn_end ONLY if actually injected.
 *  - Non-fatal: any failure returns the unmodified messages array.
 *  - Flag OFF: no-op (returns messages unchanged — byte-identical pre-sprint;
 *    session-handlers.ts keeps the legacy systemPrompt prepend path).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";

/**
 * True when recall blocks are staged AND the feature flag is ON. Called by the
 * context handler to decide whether to call withRecallTail.
 */
export function stagedForTail(
	runtime: MegaRuntime,
	config: MegaConfig,
): boolean {
	if (!config.recallTailInject) return false;
	return (
		runtime.pendingRecallBlock != null ||
		runtime.pendingMemoryRecallBlock != null
	);
}

/**
 * Append staged recall/memory blocks as a single user-role message at the very
 * tail of the messages array. Returns a NEW array (does not mutate input).
 *
 * Sets `runtime.recallInjectedThisTurn = true` when it actually appends, so the
 * turn_end handler (agent-handlers.ts) consumes the staged blocks only if they
 * reached a view this turn. If a turn ends with no context event, the flag
 * stays false and the blocks remain staged for the next turn.
 *
 * Stable timestamp (runtime.perfTurnStart ?? Date.now()) so replays within the
 * turn are byte-identical (mirrors the v0.8.6 summaryAgentMsg rationale).
 *
 * Non-fatal: on any failure, returns messages unmodified and does NOT set the
 * injected flag. PREVENT-PI-003: the injected message has role "user", never
 * "system".
 */
export function withRecallTail(
	messages: readonly AgentMessage[],
	runtime: MegaRuntime,
	config: MegaConfig,
): AgentMessage[] {
	if (!config.recallTailInject) return messages as AgentMessage[];
	try {
		const blocks: string[] = [];
		if (runtime.pendingRecallBlock != null) {
			blocks.push(runtime.pendingRecallBlock);
		}
		if (runtime.pendingMemoryRecallBlock != null) {
			blocks.push(runtime.pendingMemoryRecallBlock);
		}
		if (blocks.length === 0) return messages as AgentMessage[];

		const tailText = blocks.join("\n\n");
		const timestamp =
			runtime.perfTurnStart ?? // stable within a turn
			Date.now();

		const tailMsg = {
			role: "user" as const,
			content: tailText,
			timestamp,
		} as unknown as AgentMessage;

		runtime.rt.recallInjectedThisTurn = true;
		// Append at the very tail — never splits toolCall/toolResult.
		// PREVENT-PI-001/002: a single message appended after a complete
		// transcript prefix cannot split a toolCall/toolResult pair.
		return [...messages, tailMsg];
	} catch {
		// Non-fatal: leave blocks staged (flag stays unset) and return the
		// unmodified view. The context event still proceeds normally.
		return messages as AgentMessage[];
	}
}
