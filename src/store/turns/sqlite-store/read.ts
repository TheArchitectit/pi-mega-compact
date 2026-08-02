/**
 * read.ts — TurnReader method bodies (extracted from sqlite-store.ts). All
 * queries use bound parameters (PREVENT-002). Append-only reads.
 */
import type {
	ConversationId,
	ConversationStats,
	TurnEntry,
	TurnFilter,
	TurnId,
	TurnRecallEntry,
	ConversationFork,
} from "../types.js";
import type { SqliteTurnStoreCtx } from "./ctx.js";
import { normalizeSessionId, rowToEntry, rowToRecall, rowToFork } from "./rows.js";

export function query(ctx: SqliteTurnStoreCtx, filter: TurnFilter): TurnEntry[] {
	const { db } = ctx;
	const clauses: string[] = [];
	const params: (string | number)[] = [];

	if (filter.conversationId !== undefined) {
		clauses.push("conversation_id = ?");
		params.push(filter.conversationId);
	}
	if (filter.sessionId !== undefined) {
		clauses.push("session_id = ?");
		params.push(normalizeSessionId(filter.sessionId));
	}
	if (filter.sinceMs !== undefined) {
		clauses.push("ended_at >= ?");
		params.push(filter.sinceMs);
	}
	if (filter.untilMs !== undefined) {
		clauses.push("ended_at <= ?");
		params.push(filter.untilMs);
	}
	if (filter.pressureBand !== undefined) {
		clauses.push("pressure_band = ?");
		params.push(filter.pressureBand);
	}

	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const limit = filter.limit ?? 1000;
	const offset = filter.offset ?? 0;

	const rows = db
		.prepare(
			`SELECT * FROM turns ${where} ORDER BY ended_at ASC LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset) as Array<Record<string, unknown>>;

	return rows.map(rowToEntry);
}

export function getTurn(
	ctx: SqliteTurnStoreCtx,
	turnId: TurnId,
): TurnEntry | undefined {
	const { db } = ctx;
	const row = db
		.prepare("SELECT * FROM turns WHERE id = ?")
		.get(Number(turnId)) as Record<string, unknown> | undefined;
	return row ? rowToEntry(row) : undefined;
}

export function getTurnByIndex(
	ctx: SqliteTurnStoreCtx,
	conversationId: ConversationId,
	turnIndex: number,
): TurnEntry | undefined {
	const { db } = ctx;
	const row = db
		.prepare(
			"SELECT * FROM turns WHERE conversation_id = ? AND turn_index = ?",
		)
		.get(conversationId, turnIndex) as Record<string, unknown> | undefined;
	return row ? rowToEntry(row) : undefined;
}

export function listRecall(
	ctx: SqliteTurnStoreCtx,
	turnId: TurnId,
): TurnRecallEntry[] {
	const { db } = ctx;
	const rows = db
		.prepare(
			"SELECT * FROM turn_recall WHERE turn_id = ? ORDER BY score DESC",
		)
		.all(Number(turnId)) as Array<Record<string, unknown>>;
	return rows.map(rowToRecall);
}

export function listRecallByIndex(
	ctx: SqliteTurnStoreCtx,
	conversationId: ConversationId,
	turnIndex: number,
): TurnRecallEntry[] {
	const { db } = ctx;
	const row = db
		.prepare(
			"SELECT id FROM turns WHERE conversation_id = ? AND turn_index = ?",
		)
		.get(conversationId, turnIndex) as { id: number } | undefined;
	if (!row) return [];
	return listRecall(ctx, String(row.id));
}

export function listForks(
	ctx: SqliteTurnStoreCtx,
	conversationId: ConversationId,
): ConversationFork[] {
	const { db } = ctx;
	const rows = db
		.prepare(
			"SELECT * FROM conversation_forks WHERE parent_conversation_id = ? ORDER BY created_at ASC",
		)
		.all(conversationId) as Array<Record<string, unknown>>;
	return rows.map(rowToFork);
}

export function countTurns(
	ctx: SqliteTurnStoreCtx,
	conversationId: ConversationId,
): number {
	const { db } = ctx;
	const row = db
		.prepare("SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ?")
		.get(conversationId) as { cnt: number };
	return row.cnt;
}

export function conversationStats(
	ctx: SqliteTurnStoreCtx,
	conversationId: ConversationId,
): ConversationStats {
	const { db } = ctx;
	const rows = db
		.prepare(
			"SELECT ended_at, ctx_percent, pressure_band FROM turns WHERE conversation_id = ? ORDER BY ended_at ASC",
		)
		.all(conversationId) as Array<Record<string, unknown>>;

	if (rows.length === 0) {
		return {
			turnCount: 0,
			firstTurnAt: 0,
			lastTurnAt: 0,
			avgCtxPercent: 0,
			pressureBands: {},
		};
	}

	let ctxSum = 0;
	let ctxCount = 0;
	const bands: Record<string, number> = {};

	for (const r of rows) {
		if (r.ctx_percent !== null) {
			ctxSum += r.ctx_percent as number;
			ctxCount++;
		}
		const band = r.pressure_band as string | null;
		if (band) bands[band] = (bands[band] ?? 0) + 1;
	}

	return {
		turnCount: rows.length,
		firstTurnAt: rows[0].ended_at as number,
		lastTurnAt: rows[rows.length - 1].ended_at as number,
		avgCtxPercent: ctxCount > 0 ? ctxSum / ctxCount : 0,
		pressureBands: bands,
	};
}
