/**
 * api-contracts/turns.ts — S52 turn-by-turn memory tracking + recall contracts.
 *
 * The dashboard Turns tab surfaces the S49/S50/S51 data spine: per-conversation
 * turn lists with per-turn metrics (ctx tokens/percent, recall hits, dedup,
 * compression, epoch) and per-turn recall provenance (which checkpoints were
 * injected at each turn), plus the S52 rewind-intent queue. Read-mostly via
 * `asReader()`; prune/vacuum via `asAdmin()`; fork/intent via the queue.
 */

/** One turn row with its provenance + metrics (per-conversation). */
export interface TurnRow {
	turnIndex: number;
	conversationId: string;
	sessionId: string;
	role: "user" | "assistant" | "system" | "tool";
	endedAt: number;
	ctxTokens: number | null;
	ctxPercent: number | null;
	pressureBand: "green" | "yellow" | "red" | null;
	model: string | null;
	epochId: string | null;
	/** Checkpoints/summaries injected this turn. */
	recall: RecallHit[];
}

/** A recall hit recorded for a turn (provenance). */
export interface RecallHit {
	checkpointId: string;
	score: number;
	source: "checkpoint" | "cluster_summary" | "memory";
	raptorLevel: number | null;
}

/** Conversation rollup in the turns tab list. */
export interface ConversationSummary {
	conversationId: string;
	turnCount: number;
	firstTurnAt: number;
	lastTurnAt: number;
	avgCtxPercent: number;
	/** Distinct epochs that compacted this conversation's turns. */
	epochCount: number;
	/** Sum of recall hits across all turns. */
	totalRecall: number;
}

/** GET /api/turns — the Turns tab payload. */
export interface TurnsResponse {
	conversations: ConversationSummary[];
	/** The active conversation (most recent turn) pre-expanded, or null. */
	activeConversationId: string | null;
}

/** GET /api/turns/:conversationId — per-turn detail for one conversation. */
export interface ConversationTurnsResponse {
	conversationId: string;
	turns: TurnRow[];
}

/** GET /api/turns/intents — pending rewind intents (S52A). */
export interface RewindIntentsResponse {
	intents: Array<{
		id: string;
		conversationId: string;
		targetTurnIndex: number;
		createdAt: number;
		status: "pending" | "consumed";
	}>;
}

/** POST /api/fork — fork a conversation at a turn. */
export interface ForkRequest {
	conversationId: string;
	turnIndex: number;
}

/** POST /api/fork response. */
export interface ForkResponse {
	childConversationId: string;
	recalledCount: number;
	checkpointIds: string[];
}

/** POST /api/turns/intent — post a rewind intent. */
export interface PostIntentRequest {
	conversationId: string;
	targetTurnIndex: number;
}

/** POST /api/turns/prune — admin prune (capability-gated). */
export interface PruneRequest {
	maxTurnAgeMs: number;
	keepMinPerConversation?: number;
}

/** POST /api/turns/prune response. */
export interface PruneTurnsResponse {
	turnsRemoved: number;
	recallRemoved: number;
	branchesPreserved: number;
	freedBytes: number;
}

/** GET /api/topics/:topicId/memories — drill-down: member memories of a wiki topic (S52). */
export interface TopicMemoriesResponse {
	topicId: string;
	label: string;
	assignments: Array<{
		memoryId: string;
		confidence: number | null;
		assignedAt: number | null;
	}>;
}
