/**
 * memory-store.ts — InMemoryTurnStore: test harness + embeddable backend.
 *
 * Same contract as SqliteTurnStore, backed by Maps. No file I/O.
 * Used for tests and for hosts that don't want SQLite.
 *
 * PREVENT-PI-004: no network. PREVENT-002: no SQL here.
 */

import { randomBytes } from "node:crypto";
import { DuplicateTurnError } from "./types.js";
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
	epochId?: string;
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
		return row ? { ...row.entry, epochId: row.epochId } : undefined;
	}

	getTurnByIndex(
		conversationId: ConversationId,
		turnIndex: number,
	): TurnEntry | undefined {
		const ids = this.convIndex.get(conversationId) ?? [];
		for (const id of ids) {
			const row = this.turns.get(id);
			if (row && row.entry.turnIndex === turnIndex) {
				return { ...row.entry, epochId: row.epochId };
			}
		}
		return undefined;
	}

	listRecall(turnId: TurnId): TurnRecallEntry[] {
		return this.recall
			.filter((r) => r.turnId === Number(turnId))
			.map((r) => r.entry)
			.sort((a, b) => b.score - a.score);
	}

	listRecallByIndex(
		conversationId: ConversationId,
		turnIndex: number,
	): TurnRecallEntry[] {
		const turn = this.getTurnByIndex(conversationId, turnIndex);
		if (!turn) return [];
		// Resolve the numeric row id for this turn via the convIndex.
		const ids = this.convIndex.get(conversationId) ?? [];
		for (const id of ids) {
			const row = this.turns.get(id);
			if (row && row.entry.turnIndex === turnIndex) {
				return this.listRecall(String(id));
			}
		}
		return [];
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
		// ISSUE #9: a turn already exists at this coordinate → throw the typed
		// DuplicateTurnError, matching SqliteTurnStore. Previously InMemory
		// silently stored a second row (no uniqueness check) while Sqlite threw —
		// the contract diverged and in-memory tests couldn't catch a duplicate
		// that explodes on SQLite. The coordinate is unique by construction.
		const convIds = this.convIndex.get(entry.conversationId) ?? [];
		for (const id of convIds) {
			const existing = this.turns.get(id);
			if (existing?.entry.turnIndex === entry.turnIndex) {
				throw new DuplicateTurnError(entry.conversationId, entry.turnIndex);
			}
		}
		const id = allocId();
		const sid = normalizeSessionId(entry.sessionId);
		const normalized = { ...entry, sessionId: sid };
		this.turns.set(id, { id, entry: normalized });

		// Update indices
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
		// Generate and store a new conversation ID for this session
		const convId = newConversationId();
		this.sessionConv.set(sid, convId);
		return convId;
	}

	forkConversation(
		parentId: ConversationId,
		forkTurnIndex: number,
	): ConversationId {
		const childId = newConversationId();
		const now = Date.now();

		// 1. Record the fork lineage
		this.forks.push({
			parentConversationId: parentId,
			childConversationId: childId,
			forkTurnIndex,
			createdAt: now,
		});

		// 2. Find the parent's turn at forkTurnIndex
		const parentTurnIds = this.convIndex.get(parentId) ?? [];
		const parentTurnRow = parentTurnIds
			.map((id) => this.turns.get(id))
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
		this.turns.set(seedId, { id: seedId, entry: seedEntry });
		this.convIndex.set(childId, [seedId]);

		// 4. Copy the parent's recall entries into the child's seed turn
		const parentRecall = this.recall.filter(
			(r) => r.turnId === parentTurnRow.id,
		);
		for (const r of parentRecall) {
			this.recall.push({
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
		// Emit turns in a stable order (by internal ID / insertion order)
		const sorted = [...this.turns.values()].sort((a, b) => a.id - b.id);
		const turns = sorted.map((r) => r.entry);

		// Build mapping: internal ID → 1-based position
		const idToPos = new Map<number, number>();
		for (let i = 0; i < sorted.length; i++) {
			idToPos.set(sorted[i].id, i + 1);
		}

		// Replace recall's turnId with the stable 1-based position
		const recall = this.recall.map((r) => ({
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
			forks: [...this.forks],
		};
	}

	restore(from: StoreSnapshot): void {
		this.clear();

		// Map: 1-based position → new internal ID
		const posToNewId = new Map<number, number>();

		for (let i = 0; i < from.turns.length; i++) {
			const t = from.turns[i];
			const newId = allocId();
			const sid = normalizeSessionId(t.sessionId);
			const normalized = { ...t, sessionId: sid };
			this.turns.set(newId, { id: newId, entry: normalized });

			// Update indices
			const convIds = this.convIndex.get(t.conversationId) ?? [];
			convIds.push(newId);
			this.convIndex.set(t.conversationId, convIds);
			this.sessionConv.set(sid, t.conversationId);

			posToNewId.set(i + 1, newId);
		}

		// Re-attach recall with position-based TurnId → new internal ID mapping
		for (const r of from.recall) {
			const targetInternalId = posToNewId.get(Number(r.turnId));
			if (targetInternalId !== undefined) {
				this.recall.push({
					turnId: targetInternalId,
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

	stampTurnsEpoch(sessionId: SessionId, epochId: string): number {
		const sid = normalizeSessionId(sessionId);
		let stamped = 0;
		for (const row of this.turns.values()) {
			if (row.epochId === undefined && row.entry.sessionId === sid) {
				row.epochId = epochId;
				stamped++;
			}
		}
		return stamped;
	}

	// ── Capability gating ───────────────────────────────────────

	asReader(): TurnReader {
		return {
			query: (f) => this.query(f),
			getTurn: (id) => this.getTurn(id),
			getTurnByIndex: (c, t) => this.getTurnByIndex(c, t),
			listRecall: (id) => this.listRecall(id),
			listRecallByIndex: (c, t) => this.listRecallByIndex(c, t),
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
			stampTurnsEpoch: (s, e) => this.stampTurnsEpoch(s, e),
		};
	}

	close(): void {
		// No-op for in-memory store
		this.clear();
	}
}
