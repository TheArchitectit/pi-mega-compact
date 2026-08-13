/**
 * write.ts — TurnWriter method bodies for InMemoryTurnStore (extracted from
 * memory-store.ts). Free functions operating on a MemoryTurnStoreCtx; the
 * shell class delegates here. Mirrors sqlite-store/write.ts.
 */
import {
	DuplicateTurnError,
	type ConversationId,
	type SessionId,
	type TurnEntry,
	type TurnId,
	type TurnRecallEntry,
} from "../types.js";
import {
	allocId,
	newConversationId,
	normalizeSessionId,
	type MemoryTurnStoreCtx,
} from "./ctx.js";

export function appendTurn(
	ctx: MemoryTurnStoreCtx,
	entry: TurnEntry,
): TurnId {
	// Check for duplicate (conversationId, turnIndex)
	for (const [, row] of ctx.turns) {
		if (
			row.entry.conversationId === entry.conversationId &&
			row.entry.turnIndex === entry.turnIndex
		) {
			throw new DuplicateTurnError(entry.conversationId, entry.turnIndex);
		}
	}
	const id = allocId();
	const sid = normalizeSessionId(entry.sessionId);
	const normalized = { ...entry, sessionId: sid };
	ctx.turns.set(id, { id, entry: normalized });

	// Update indices
	const convIds = ctx.convIndex.get(entry.conversationId) ?? [];
	convIds.push(id);
	ctx.convIndex.set(entry.conversationId, convIds);

	ctx.sessionConv.set(sid, entry.conversationId);

	return String(id);
}

export function appendRecall(ctx: MemoryTurnStoreCtx, entry: TurnRecallEntry): void {
	// De-dup by (turn_id, checkpoint_id)
	const exists = ctx.recall.some(
		(r) =>
			r.turnId === Number(entry.turnId) &&
			r.entry.checkpointId === entry.checkpointId,
	);
	if (!exists) {
		ctx.recall.push({ turnId: Number(entry.turnId), entry });
	}
}

export function ensureConversationId(
	ctx: MemoryTurnStoreCtx,
	sessionId: SessionId,
): ConversationId {
	const sid = normalizeSessionId(sessionId);
	const existing = ctx.sessionConv.get(sid);
	if (existing) return existing;
	// Generate and store a new conversation ID for this session
	const convId = newConversationId();
	ctx.sessionConv.set(sid, convId);
	return convId;
}

export function forkConversation(
	ctx: MemoryTurnStoreCtx,
	parentId: ConversationId,
	forkTurnIndex: number,
): ConversationId {
	const childId = newConversationId();
	const now = Date.now();

	// 1. Record the fork lineage
	ctx.forks.push({
		parentConversationId: parentId,
		childConversationId: childId,
		forkTurnIndex,
		createdAt: now,
	});

	// 2. Find the parent's turn at forkTurnIndex
	const parentTurnIds = ctx.convIndex.get(parentId) ?? [];
	const parentTurnRow = parentTurnIds
		.map((id) => ctx.turns.get(id))
		.find((r) => r?.entry.turnIndex === forkTurnIndex);

	if (!parentTurnRow) return childId; // no parent turn — nothing to seed

	// 3. Create a seed turn in the child conversation
	const seedId = allocId();
	const seedEntry: TurnEntry = {
		conversationId: childId,
		sessionId: `fork_${childId}`,
		turnIndex: 0,
		role: "system",
		endedAt: now,
	};
	ctx.turns.set(seedId, { id: seedId, entry: seedEntry });
	ctx.convIndex.set(childId, [seedId]);

	// 4. Copy the parent's recall entries into the child's seed turn
	const parentRecall = ctx.recall.filter((r) => r.turnId === parentTurnRow.id);
	for (const r of parentRecall) {
		ctx.recall.push({
			turnId: seedId,
			entry: {
				turnId: String(seedId),
				checkpointId: r.entry.checkpointId,
				score: r.entry.score,
				source: r.entry.source,
				raptorLevel: r.entry.raptorLevel,
			},
		});
	}

	return childId;
}
