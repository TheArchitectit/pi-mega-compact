/**
 * write.ts — TurnWriter method bodies (extracted from sqlite-store.ts). All
 * queries use bound parameters (PREVENT-002). Append-only: no UPDATE on
 * turns/turn_recall after INSERT (only in migration).
 */
import type {
	ConversationId,
	SessionId,
	TurnEntry,
	TurnId,
	TurnRecallEntry,
} from "../types.js";
import { DuplicateTurnError } from "../types.js";
import type { SqliteTurnStoreCtx } from "./ctx.js";
import { newConversationId, normalizeSessionId } from "./rows.js";

export function appendTurn(ctx: SqliteTurnStoreCtx, entry: TurnEntry): TurnId {
	const { db } = ctx;
	const sid = normalizeSessionId(entry.sessionId);
	persistSessionConv(ctx, sid, entry.conversationId);
	try {
		db
			.prepare(
				`INSERT INTO turns (conversation_id, session_id, turn_index, role, ended_at,
	                           ctx_tokens, ctx_percent, pressure_band, model, epoch_id,
	                           hyde_ran, hyde_doc, hyde_raw_count, hyde_hyde_count,
	                           hyde_fused_count, hyde_lift, hyde_generation_ms, hyde_reason,
	                           recall_score, recall_pass, recall_relevance, recall_coverage,
	                           recall_diversity, recall_specificity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				entry.conversationId,
				sid,
				entry.turnIndex,
				entry.role,
				entry.endedAt,
				entry.ctxTokens ?? null,
				entry.ctxPercent ?? null,
				entry.pressureBand ?? null,
				entry.model ?? null,
				entry.epochId ?? null,
				entry.hyde?.ran == null ? null : entry.hyde.ran ? 1 : 0,
				entry.hyde?.hypotheticalDoc ?? null,
				entry.hyde?.rawHitCount ?? null,
				entry.hyde?.hydeHitCount ?? null,
				entry.hyde?.fusedHitCount ?? null,
				entry.hyde?.lift ?? null,
				entry.hyde?.generationMs ?? null,
				entry.hyde?.reason ?? null,
				entry.recallMetrics?.score ?? null,
				entry.recallMetrics?.pass == null ? null : entry.recallMetrics.pass ? 1 : 0,
				entry.recallMetrics?.relevance ?? null,
				entry.recallMetrics?.coverage ?? null,
				entry.recallMetrics?.diversity ?? null,
				entry.recallMetrics?.specificity ?? null,
			);
	} catch (e) {
		if (
			e instanceof Error &&
			e.message.includes("UNIQUE constraint") &&
			(e as { code?: string }).code === "ERR_SQLITE_ERROR"
		) {
			throw new DuplicateTurnError(entry.conversationId, entry.turnIndex);
		}
		throw e;
	}
	const row = db
		.prepare(
			"SELECT id FROM turns WHERE conversation_id = ? AND turn_index = ?",
		)
		.get(entry.conversationId, entry.turnIndex) as { id: number } | undefined;
	return String(row!.id);
}

/** Persist the session → conversation mapping when a turn is written. */
function persistSessionConv(
	ctx: SqliteTurnStoreCtx,
	sid: string,
	conversationId: string,
): void {
	ctx.db
		.prepare(
			"INSERT OR IGNORE INTO session_conversations (session_id, conversation_id) VALUES (?, ?)",
		)
		.run(sid, conversationId);
}

export function appendRecall(
	ctx: SqliteTurnStoreCtx,
	entry: TurnRecallEntry,
): void {
	const { db } = ctx;
	db
		.prepare(
			`INSERT OR IGNORE INTO turn_recall (turn_id, checkpoint_id, score, source, raptor_level)
         VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			Number(entry.turnId),
			entry.checkpointId,
			entry.score,
			entry.source,
			entry.raptorLevel ?? null,
		);
}

export function ensureConversationId(
	ctx: SqliteTurnStoreCtx,
	sessionId: SessionId,
): ConversationId {
	const { db } = ctx;
	const sid = normalizeSessionId(sessionId);
	// Check session_conversations table first (persistent mapping)
	const row = db
		.prepare(
			"SELECT conversation_id FROM session_conversations WHERE session_id = ?",
		)
		.get(sid) as { conversation_id: string } | undefined;
	if (row) return row.conversation_id;

	// Check if any turn exists for this session (fallback)
	const turnRow = db
		.prepare(
			"SELECT conversation_id FROM turns WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1",
		)
		.get(sid) as { conversation_id: string } | undefined;
	if (turnRow) {
		// Persist the mapping so future calls are consistent
		db
			.prepare(
				"INSERT OR IGNORE INTO session_conversations (session_id, conversation_id) VALUES (?, ?)",
			)
			.run(sid, turnRow.conversation_id);
		return turnRow.conversation_id;
	}

	// No turns yet — generate and persist a new conversation id
	const convId = newConversationId();
	db
		.prepare(
			"INSERT OR IGNORE INTO session_conversations (session_id, conversation_id) VALUES (?, ?)",
		)
		.run(sid, convId);
	return convId;
}

export function forkConversation(
	ctx: SqliteTurnStoreCtx,
	parentId: ConversationId,
	forkTurnIndex: number,
): ConversationId {
	const { db } = ctx;
	const childId = newConversationId();
	const now = Date.now();

	// 1. Record the fork lineage
	db
		.prepare(
			`INSERT INTO conversation_forks (parent_conversation_id, child_conversation_id, fork_turn_index, created_at)
         VALUES (?, ?, ?, ?)`,
		)
		.run(parentId, childId, forkTurnIndex, now);

	// 2. Find the parent's turn at forkTurnIndex
	const parentTurn = db
		.prepare(
			"SELECT id FROM turns WHERE conversation_id = ? AND turn_index = ?",
		)
		.get(parentId, forkTurnIndex) as { id: number } | undefined;

	if (!parentTurn) return childId; // no parent turn at that index — nothing to seed

	// 3. Create a seed turn in the child conversation (turnIndex 0, role system)
	db
		.prepare(
			`INSERT INTO turns (conversation_id, session_id, turn_index, role, ended_at)
         VALUES (?, ?, 0, 'system', ?)`,
		)
		.run(childId, `fork_${childId}`, now);

	const childTurnRow = db
		.prepare(
			"SELECT id FROM turns WHERE conversation_id = ? AND turn_index = 0",
		)
		.get(childId) as { id: number } | undefined;
	if (!childTurnRow) return childId;

	// 4. Copy the parent's recall entries into the child's seed turn
	const parentRecall = db
		.prepare(
			"SELECT checkpoint_id, score, source, raptor_level FROM turn_recall WHERE turn_id = ?",
		)
		.all(parentTurn.id) as Array<Record<string, unknown>>;

	const insertRecall = db.prepare(
		`INSERT OR IGNORE INTO turn_recall (turn_id, checkpoint_id, score, source, raptor_level)
         VALUES (?, ?, ?, ?, ?)`,
	);
	for (const r of parentRecall) {
		insertRecall.run(
			childTurnRow.id,
			r.checkpoint_id as string,
			r.score as number,
			r.source as string,
			(r.raptor_level as number | null) ?? null,
		);
	}

	return childId;
}
