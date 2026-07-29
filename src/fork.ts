/**
 * fork.ts — S50C host-agnostic conversation-fork primitive.
 *
 * Pi-agnostic: consumes only the S49 `TurnStore` contract. A "fork" branches a
 * new child conversation off a parent's turn N and inherits that turn's
 * injected-checkpoint set as its starting recall state (recall-to-point — NOT a
 * live-window replay, which stays an S48 non-goal). The host (pi command,
 * dashboard intent, own TUI, API gateway) supplies the store + identifiers and
 * applies the returned recall set to its own session state.
 *
 * PREVENT-PI-001/002: fork writes to conversation_forks only; it never mutates
 * memory, drop ranges, or the parent's turns. No network (PREVENT-PI-004).
 */
import type {
	TurnStore,
	TurnEntry,
	TurnRecallEntry,
} from "./store/turns/types.js";

/** Result of a fork: the new child conversation + the recall set to rehydrate. */
export interface ForkOutcome {
	/** Newly-created child conversation id. */
	childConversationId: string;
	/** The parent turn the fork branched from (contract TurnEntry). */
	forkTurn: TurnEntry;
	/** The parent's injected checkpoints at the fork turn (the replay set). */
	recalled: TurnRecallEntry[];
	/** Distinct checkpoint ids to seed into the child's injected-set. */
	checkpointIds: string[];
}

/** Typed error so hosts can distinguish "unknown turn" from storage failures. */
export class ForkError extends Error {
	readonly code: "TURN_NOT_FOUND" | "NO_RECALL";
	constructor(code: ForkError["code"], message: string) {
		super(message);
		this.name = "ForkError";
		this.code = code;
	}
}

/**
 * Fork `parentConversationId` at `turnIndex`. Resolves the turn entry (by
 * conversation + index via `getTurnByIndex`), creates the child conversation via
 * `store.forkConversation` (returns the child ConversationId), and returns the
 * parent turn's recorded recall set (`listRecallByIndex`) to rehydrate.
 *
 * @throws ForkError TURN_NOT_FOUND when the (conversation, turnIndex) row is absent.
 * @throws ForkError NO_RECALL when the fork turn has no injected checkpoints to replay.
 */
export function forkFromConversation(
	store: TurnStore,
	parentConversationId: string,
	turnIndex: number,
): ForkOutcome {
	const turn = store.getTurnByIndex(parentConversationId, turnIndex);
	if (!turn) {
		throw new ForkError(
			"TURN_NOT_FOUND",
			`no turn ${turnIndex} in conversation ${parentConversationId}`,
		);
	}
	const childConversationId = store.forkConversation(
		parentConversationId,
		turnIndex,
	);
	const recalled = store.listRecallByIndex(parentConversationId, turnIndex);
	const checkpointIds = [...new Set(recalled.map((r) => r.checkpointId))];
	if (checkpointIds.length === 0) {
		// The child conversation was still created (lineage is recorded), but a fork
		// with nothing to rehydrate is almost always a caller mistake — surface it.
		throw new ForkError(
			"NO_RECALL",
			`turn ${turnIndex} in ${parentConversationId} has no injected checkpoints to fork from`,
		);
	}
	return { childConversationId, forkTurn: turn, recalled, checkpointIds };
}
