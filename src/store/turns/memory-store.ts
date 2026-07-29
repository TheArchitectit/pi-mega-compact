/**
 * memory-store.ts — InMemoryTurnStore: test harness + embeddable backend.
 *
 * Same contract as SqliteTurnStore, backed by Maps. No file I/O.
 * Used for tests and for hosts that don't want SQLite.
 *
 * PREVENT-PI-004: no network. PREVENT-002: no SQL here.
 */

import { randomBytes } from "node:crypto";
import type {
	TurnStore,
	TurnReader,
	TurnWriter,
	TurnAdmin,
	TurnId,
	ConversationId,
	SessionId,
	TurnEntry,
	TurnRecallEntry,
	ConversationFork,
	TurnFilter,
	PruneReport,
	RetentionPolicy,
	StoreSnapshot,
	ConversationStats,
	TurnStoreOptions,
} from "./types.js";

function newConversationId(): ConversationId {
	return `conv_${randomBytes(8).toString("hex")}`;
}

function normalizeSessionId(sid: SessionId): SessionId {
	return sid.replace(/-.*$/, "");
}

// Auto-increment counter
let nextId = 1;
function allocId(): number {
	return nextId++;
}
function resetIdCounter(): void {
	nextId = 1;
}

// Internal row with numeric id
interface TurnRow {
	id: number;
	entry: TurnEntry;
}

interface RecallRow {
	turnId: number;
	entry: TurnRecallEntry;
}

export class InMemoryTurnStore implements TurnStore {
	private turns: Map<number, TurnRow> = new Map();
	private recall: RecallRow[] = [];
	private forks: ConversationFork[] = [];
	// conversation_id → turn ids (for fast lookup)
	private convIndex: Map<ConversationId, number[]> = new Map();
	// session_id → conversation_id
	private sessionConv: Map<SessionId, ConversationId> = new Map();

	constructor(_options?: TurnStoreOptions) {
		resetIdCounter();
	}

	// ── TurnReader ──────────────────────────────────────────────

	query(filter: TurnFilter): TurnEntry[] {
		let results = [...this.turns.values()].map((r) => r.entry);

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

	getTurn(turnId: TurnId): TurnEntry | undefined {
		const row = this.turns.get(Number(turnId));
		return row?.entry;
	}

	listRecall(turnId: TurnId): TurnRecallEntry[] {
		return this.recall
			.filter((r) => r.turnId === Number(turnId))
			.map((r) => r.entry)
			.sort((a, b) => b.score - a.score);
	}

	listForks(conversationId: ConversationId): ConversationFork[] {
		return this.forks
			.filter((f) => f.parentConversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	countTurns(conversationId: ConversationId): number {
		const ids = this.convIndex.get(conversationId);
		return ids?.length ?? 0;
	}

	conversationStats(conversationId: ConversationId): ConversationStats {
		const ids = this.convIndex.get(conversationId) ?? [];
		const entries = ids
			.map((id) => this.turns.get(id)?.entry)
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

	// ── TurnWriter ──────────────────────────────────────────────

	appendTurn(entry: TurnEntry): TurnId {
		const id = allocId();
		const sid = normalizeSessionId(entry.sessionId);
		const normalized = { ...entry, sessionId: sid };
		this.turns.set(id, { id, entry: normalized });

		// Update indices
		const convIds = this.convIndex.get(entry.conversationId) ?? [];
		convIds.push(id);
		this.convIndex.set(entry.conversationId, convIds);

		this.sessionConv.set(sid, entry.conversationId);

		return String(id);
	}

	appendRecall(entry: TurnRecallEntry): void {
		// De-dup by (turn_id, checkpoint_id)
		const exists = this.recall.some(
			(r) =>
				r.turnId === Number(entry.turnId) &&
				r.entry.checkpointId === entry.checkpointId,
		);
		if (!exists) {
			this.recall.push({ turnId: Number(entry.turnId), entry });
		}
	}

	ensureConversationId(sessionId: SessionId): ConversationId {
		const sid = normalizeSessionId(sessionId);
		const existing = this.sessionConv.get(sid);
		if (existing) return existing;
		return newConversationId();
	}

	forkConversation(
		parentId: ConversationId,
		forkTurnIndex: number,
	): ConversationId {
		const childId = newConversationId();
		this.forks.push({
			parentConversationId: parentId,
			childConversationId: childId,
			forkTurnIndex,
			createdAt: Date.now(),
		});
		return childId;
	}

	// ── TurnAdmin ───────────────────────────────────────────────

	prune(policy: RetentionPolicy): PruneReport {
		const cutoff = Date.now() - policy.maxTurnAgeMs;
		let turnsRemoved = 0;
		let recallRemoved = 0;

		for (const [convId, turnIds] of this.convIndex.entries()) {
			const total = turnIds.length;
			const canDelete = Math.max(0, total - policy.keepMinPerConversation);
			if (canDelete === 0) continue;

			// Find old turns to delete
			const oldIds = turnIds
				.filter((id) => {
					const row = this.turns.get(id);
					return row && row.entry.endedAt < cutoff;
				})
				.slice(0, canDelete);

			for (const id of oldIds) {
				// Remove recall
				const before = this.recall.length;
				this.recall = this.recall.filter((r) => r.turnId !== id);
				recallRemoved += before - this.recall.length;

				this.turns.delete(id);
				turnsRemoved++;
			}

			// Update convIndex
			this.convIndex.set(
				convId,
				turnIds.filter((id) => this.turns.has(id)),
			);
		}

		const branchesPreserved = this.forks.length;

		return {
			turnsRemoved,
			recallRemoved,
			branchesPreserved,
			freedBytes: 0, // in-memory — no file size to measure
		};
	}

	vacuum(): void {
		// No-op for in-memory store
	}

	checkpoint(): StoreSnapshot {
		return {
			version: 1,
			exportedAt: Date.now(),
			turns: [...this.turns.values()].map((r) => r.entry),
			recall: this.recall.map((r) => r.entry),
			forks: [...this.forks],
		};
	}

	restore(from: StoreSnapshot): void {
		this.clear();
		// Map old numeric IDs to new IDs
		const idRemap = new Map<number, number>();

		for (const t of from.turns) {
			const newId = allocId();
			const sid = normalizeSessionId(t.sessionId);
			const normalized = { ...t, sessionId: sid };
			this.turns.set(newId, { id: newId, entry: normalized });

			// Update indices
			const convIds = this.convIndex.get(t.conversationId) ?? [];
			convIds.push(newId);
			this.convIndex.set(t.conversationId, convIds);
			this.sessionConv.set(sid, t.conversationId);

			// Track sequential mapping (assumes insertion order = ID order)
			idRemap.set(this.turns.size, newId);
		}

		// Re-attach recall with remapped turn IDs
		const turnEntries = [...this.turns.values()].sort((a, b) => a.id - b.id);
		for (const r of from.recall) {
			const idx = Number(r.turnId) - 1; // 1-based → 0-based index
			if (idx >= 0 && idx < turnEntries.length) {
				this.recall.push({
					turnId: turnEntries[idx].id,
					entry: r,
				});
			}
		}

		this.forks = [...from.forks];
	}

	clear(): void {
		this.turns.clear();
		this.recall = [];
		this.forks = [];
		this.convIndex.clear();
		this.sessionConv.clear();
		resetIdCounter();
	}

	// ── Capability gating ───────────────────────────────────────

	asReader(): TurnReader {
		return {
			query: (f) => this.query(f),
			getTurn: (id) => this.getTurn(id),
			listRecall: (id) => this.listRecall(id),
			listForks: (id) => this.listForks(id),
			countTurns: (id) => this.countTurns(id),
			conversationStats: (id) => this.conversationStats(id),
		};
	}

	asWriter(): TurnWriter {
		return {
			appendTurn: (e) => this.appendTurn(e),
			appendRecall: (e) => this.appendRecall(e),
			ensureConversationId: (s) => this.ensureConversationId(s),
			forkConversation: (p, t) => this.forkConversation(p, t),
		};
	}

	asAdmin(): TurnAdmin {
		return {
			prune: (p) => this.prune(p),
			vacuum: () => this.vacuum(),
			checkpoint: () => this.checkpoint(),
			restore: (s) => this.restore(s),
			clear: () => this.clear(),
		};
	}

	close(): void {
		// No-op for in-memory store
		this.clear();
	}
}
