/**
 * rows.ts — row ↔ entry mappers + id helpers (extracted from sqlite-store.ts).
 */
import { randomBytes } from "node:crypto";
import type {
	ConversationId,
	SessionId,
	TurnEntry,
	TurnRecallEntry,
	ConversationFork,
} from "../types.js";

export function newConversationId(): ConversationId {
	return `conv_${randomBytes(8).toString("hex")}`;
}

export function normalizeSessionId(sid: SessionId): SessionId {
	// Matches the existing normalizeSessionId in src/store.ts
	return sid.replace(/-.*$/, "");
}

export function rowToEntry(r: Record<string, unknown>): TurnEntry {
	return {
		conversationId: r.conversation_id as string,
		sessionId: r.session_id as string,
		turnIndex: r.turn_index as number,
		role: r.role as TurnEntry["role"],
		endedAt: r.ended_at as number,
		ctxTokens: (r.ctx_tokens as number | null) ?? undefined,
		ctxPercent: (r.ctx_percent as number | null) ?? undefined,
		pressureBand:
			(r.pressure_band as "green" | "yellow" | "red" | null) ?? undefined,
		model: (r.model as string | null) ?? undefined,
		epochId: (r.epoch_id as string | null) ?? undefined,
		// H1: telemetry columns (only populated when the row has them non-default).
		hyde:
			r.hyde_ran == null
				? undefined
				: {
						ran: r.hyde_ran === 1,
						reason: (r.hyde_reason as string) ?? "",
						hypotheticalDoc: (r.hyde_doc as string) ?? "",
						rawHitCount: (r.hyde_raw_count as number) ?? 0,
						hydeHitCount: (r.hyde_hyde_count as number) ?? 0,
						fusedHitCount: (r.hyde_fused_count as number) ?? 0,
						lift: (r.hyde_lift as number) ?? 0,
						generationMs: (r.hyde_generation_ms as number) ?? 0,
					},
		recallMetrics:
			r.recall_score == null
				? undefined
				: {
						score: (r.recall_score as number) ?? 0,
						pass: (r.recall_pass as number) === 1,
						relevance: (r.recall_relevance as number) ?? 0,
						coverage: (r.recall_coverage as number) ?? 0,
						diversity: (r.recall_diversity as number) ?? 0,
						specificity: (r.recall_specificity as number) ?? 0,
					},
	};
}

export function rowToRecall(r: Record<string, unknown>): TurnRecallEntry {
	return {
		turnId: String(r.turn_id),
		checkpointId: r.checkpoint_id as string,
		score: r.score as number,
		source: r.source as TurnRecallEntry["source"],
		raptorLevel: (r.raptor_level as number | null) ?? undefined,
	};
}

export function rowToFork(r: Record<string, unknown>): ConversationFork {
	return {
		parentConversationId: r.parent_conversation_id as string,
		childConversationId: r.child_conversation_id as string,
		forkTurnIndex: r.fork_turn_index as number,
		createdAt: r.created_at as number,
	};
}
