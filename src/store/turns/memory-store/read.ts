/**
 * read.ts — TurnReader method bodies for InMemoryTurnStore (extracted from
 * memory-store.ts). Free functions operating on a MemoryTurnStoreCtx; the
 * shell class delegates here. Mirrors sqlite-store/read.ts.
 */
import type {
	ConversationFork,
	ConversationId,
	ConversationStats,
	TurnEntry,
	TurnFilter,
	TurnId,
	TurnRecallEntry,
} from "../types.js";
import { normalizeSessionId, type MemoryTurnStoreCtx } from "./ctx.js";

export function query(ctx: MemoryTurnStoreCtx, filter: TurnFilter): TurnEntry[] {
	let results = [...ctx.turns.values()].map((r) => r.entry);

	if (filter.conversationId !== undefined) {
		results = results.filter(
			(t) => t.conversationId === filter.conversationId,
		);
	}
	if (filter.sessionId !== undefined) {
		results = results.filter(
			(t) =>
				normalizeSessionId(t.sessionId) ===
				normalizeSessionId(filter.sessionId!),
		);
	}
	if (filter.sinceMs !== undefined) {
		results = results.filter((t) => t.endedAt >= filter.sinceMs!);
	}
	if (filter.untilMs !== undefined) {
		results = results.filter((t) => t.endedAt <= filter.untilMs!);
	}
	if (filter.pressureBand !== undefined) {
		results = results.filter((t) => t.pressureBand === filter.pressureBand);
	}

	results.sort((a, b) => a.endedAt - b.endedAt);

	const offset = filter.offset ?? 0;
	const limit = filter.limit ?? 1000;
	return results.slice(offset, offset + limit);
}

export function getTurn(
	ctx: MemoryTurnStoreCtx,
	turnId: TurnId,
): TurnEntry | undefined {
	const row = ctx.turns.get(Number(turnId));
	return row ? { ...row.entry, epochId: row.epochId } : undefined;
}

export function getTurnByIndex(
	ctx: MemoryTurnStoreCtx,
	conversationId: ConversationId,
	turnIndex: number,
): TurnEntry | undefined {
	const ids = ctx.convIndex.get(conversationId) ?? [];
	for (const id of ids) {
		const row = ctx.turns.get(id);
		if (row && row.entry.turnIndex === turnIndex) {
			return { ...row.entry, epochId: row.epochId };
		}
	}
	return undefined;
}

export function listRecall(
	ctx: MemoryTurnStoreCtx,
	turnId: TurnId,
): TurnRecallEntry[] {
	return ctx.recall
		.filter((r) => r.turnId === Number(turnId))
		.map((r) => r.entry)
		.sort((a, b) => b.score - a.score);
}

export function listRecallByIndex(
	ctx: MemoryTurnStoreCtx,
	conversationId: ConversationId,
	turnIndex: number,
): TurnRecallEntry[] {
	const turn = getTurnByIndex(ctx, conversationId, turnIndex);
	if (!turn) return [];
	// Resolve the numeric row id for this turn via the convIndex.
	const ids = ctx.convIndex.get(conversationId) ?? [];
	for (const id of ids) {
		const row = ctx.turns.get(id);
		if (row && row.entry.turnIndex === turnIndex) {
			return listRecall(ctx, String(id));
		}
	}
	return [];
}

export function listForks(
	ctx: MemoryTurnStoreCtx,
	conversationId: ConversationId,
): ConversationFork[] {
	return ctx.forks
		.filter((f) => f.parentConversationId === conversationId)
		.sort((a, b) => a.createdAt - b.createdAt);
}

export function countTurns(
	ctx: MemoryTurnStoreCtx,
	conversationId: ConversationId,
): number {
	const ids = ctx.convIndex.get(conversationId);
	return ids?.length ?? 0;
}

export function conversationStats(
	ctx: MemoryTurnStoreCtx,
	conversationId: ConversationId,
): ConversationStats {
	const ids = ctx.convIndex.get(conversationId) ?? [];
	const entries = ids
		.map((id) => ctx.turns.get(id)?.entry)
		.filter((e): e is TurnEntry => e !== undefined);

	if (entries.length === 0) {
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

	for (const e of entries) {
		if (e.ctxPercent !== undefined) {
			ctxSum += e.ctxPercent;
			ctxCount++;
		}
		if (e.pressureBand)
			bands[e.pressureBand] = (bands[e.pressureBand] ?? 0) + 1;
	}

	return {
		turnCount: entries.length,
		firstTurnAt: entries[0].endedAt,
		lastTurnAt: entries[entries.length - 1].endedAt,
		avgCtxPercent: ctxCount > 0 ? ctxSum / ctxCount : 0,
		pressureBands: bands,
	};
}

export function nextTurnIndexFor(
	ctx: MemoryTurnStoreCtx,
	conversationId: ConversationId,
): number {
	let max = -1;
	for (const [, row] of ctx.turns) {
		if (
			row.entry.conversationId === conversationId &&
			row.entry.turnIndex > max
		) {
			max = row.entry.turnIndex;
		}
	}
	return max + 1;
}
