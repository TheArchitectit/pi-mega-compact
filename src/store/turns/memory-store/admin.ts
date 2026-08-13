/**
 * admin.ts — TurnAdmin method bodies for InMemoryTurnStore (extracted from
 * memory-store.ts). Free functions operating on a MemoryTurnStoreCtx; the
 * shell class delegates here. Mirrors sqlite-store/admin.ts.
 *
 * Arrays (recall, forks) are mutated IN PLACE (push/length=0), never
 * reassigned, so the ctx references captured by the shell stay valid. This
 * differs from the original class methods, which reassigned `this.recall` /
 * `this.forks` — the rewrite is behavior-identical but in-place so the
 * extracted ctx model works.
 */
import type {
	PruneReport,
	RetentionPolicy,
	SessionId,
	StoreSnapshot,
} from "../types.js";
import {
	allocId,
	normalizeSessionId,
	resetIdCounter,
	type MemoryTurnStoreCtx,
} from "./ctx.js";

export function prune(
	ctx: MemoryTurnStoreCtx,
	policy: RetentionPolicy,
): PruneReport {
	const cutoff = Date.now() - policy.maxTurnAgeMs;
	let turnsRemoved = 0;
	let recallRemoved = 0;

	for (const [convId, turnIds] of ctx.convIndex.entries()) {
		const total = turnIds.length;
		const canDelete = Math.max(0, total - policy.keepMinPerConversation);
		if (canDelete === 0) continue;

		// Find old turns to delete
		const oldIds = turnIds
			.filter((id) => {
				const row = ctx.turns.get(id);
				return row && row.entry.endedAt < cutoff;
			})
			.slice(0, canDelete);

		for (const id of oldIds) {
			// Remove recall for this turn, in place (preserve ctx.recall reference)
			const before = ctx.recall.length;
			let w = 0;
			for (let i = 0; i < ctx.recall.length; i++) {
				if (ctx.recall[i].turnId !== id) ctx.recall[w++] = ctx.recall[i];
			}
			ctx.recall.length = w;
			recallRemoved += before - ctx.recall.length;

			ctx.turns.delete(id);
			turnsRemoved++;
		}

		// Update convIndex
		ctx.convIndex.set(
			convId,
			turnIds.filter((id) => ctx.turns.has(id)),
		);
	}

	const branchesPreserved = ctx.forks.length;

	return {
		turnsRemoved,
		recallRemoved,
		branchesPreserved,
		freedBytes: 0, // in-memory — no file size to measure
	};
}

export function vacuum(_ctx: MemoryTurnStoreCtx): void {
	// No-op for in-memory store
}

export function checkpoint(ctx: MemoryTurnStoreCtx): StoreSnapshot {
	// Emit turns in a stable order (by internal ID / insertion order)
	const sorted = [...ctx.turns.values()].sort((a, b) => a.id - b.id);
	const turns = sorted.map((r) => r.entry);

	// Build mapping: internal ID → 1-based position
	const idToPos = new Map<number, number>();
	for (let i = 0; i < sorted.length; i++) {
		idToPos.set(sorted[i].id, i + 1);
	}

	// Replace recall's turnId with the stable 1-based position
	const recall = ctx.recall.map((r) => ({
		turnId: String(idToPos.get(r.turnId) ?? r.turnId),
		checkpointId: r.entry.checkpointId,
		score: r.entry.score,
		source: r.entry.source,
		raptorLevel: r.entry.raptorLevel,
	}));

	return {
		version: 1,
		exportedAt: Date.now(),
		turns,
		recall,
		forks: [...ctx.forks],
	};
}

export function restore(ctx: MemoryTurnStoreCtx, from: StoreSnapshot): void {
	clear(ctx);

	// Map: 1-based position → new internal ID
	const posToNewId = new Map<number, number>();

	for (let i = 0; i < from.turns.length; i++) {
		const t = from.turns[i];
		const newId = allocId();
		const sid = normalizeSessionId(t.sessionId);
		const normalized = { ...t, sessionId: sid };
		ctx.turns.set(newId, { id: newId, entry: normalized });

		// Update indices
		const convIds = ctx.convIndex.get(t.conversationId) ?? [];
		convIds.push(newId);
		ctx.convIndex.set(t.conversationId, convIds);
		ctx.sessionConv.set(sid, t.conversationId);

		posToNewId.set(i + 1, newId);
	}

	// Re-attach recall with position-based TurnId → new internal ID mapping
	for (const r of from.recall) {
		const targetInternalId = posToNewId.get(Number(r.turnId));
		if (targetInternalId !== undefined) {
			ctx.recall.push({
				turnId: targetInternalId,
				entry: r,
			});
		}
	}

	// In-place replace forks (preserve ctx.forks reference)
	ctx.forks.length = 0;
	ctx.forks.push(...from.forks);
}

export function clear(ctx: MemoryTurnStoreCtx): void {
	ctx.turns.clear();
	ctx.recall.length = 0;
	ctx.forks.length = 0;
	ctx.convIndex.clear();
	ctx.sessionConv.clear();
	resetIdCounter();
}

export function stampTurnsEpoch(
	ctx: MemoryTurnStoreCtx,
	sessionId: SessionId,
	epochId: string,
): number {
	const sid = normalizeSessionId(sessionId);
	let stamped = 0;
	for (const row of ctx.turns.values()) {
		if (row.epochId === undefined && row.entry.sessionId === sid) {
			row.epochId = epochId;
			stamped++;
		}
	}
	return stamped;
}
