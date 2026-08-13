/**
 * memory-store.ts — InMemoryTurnStore: test harness + embeddable backend.
 *
 * Thin delegate shell: each method body lives as a free function in
 * ./memory-store/* (read.ts / write.ts / admin.ts) operating on an internal
 * ctx ({turns, recall, forks, convIndex, sessionConv}); this class wires those
 * to the contract. The public API surface — InMemoryTurnStore implements
 * TurnStore, all methods, asReader/asWriter/asAdmin, close — is unchanged
 * for existing callers.
 *
 * Same contract as SqliteTurnStore, backed by Maps. No file I/O. Used for
 * tests and for hosts that don't want SQLite. Mirrors sqlite-store.ts.
 *
 * PREVENT-PI-004: no network. PREVENT-002: no SQL here.
 */

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
import {
	resetIdCounter,
	type MemoryTurnStoreCtx,
	type RecallRow,
	type TurnRow,
} from "./memory-store/ctx.js";
import * as read from "./memory-store/read.js";
import * as write from "./memory-store/write.js";
import * as admin from "./memory-store/admin.js";

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

	private ctx(): MemoryTurnStoreCtx {
		return {
			turns: this.turns,
			recall: this.recall,
			forks: this.forks,
			convIndex: this.convIndex,
			sessionConv: this.sessionConv,
		};
	}

	// ── TurnReader ──────────────────────────────────────────────

	query(filter: TurnFilter): TurnEntry[] {
		return read.query(this.ctx(), filter);
	}

	getTurn(turnId: TurnId): TurnEntry | undefined {
		return read.getTurn(this.ctx(), turnId);
	}

	getTurnByIndex(
		conversationId: ConversationId,
		turnIndex: number,
	): TurnEntry | undefined {
		return read.getTurnByIndex(this.ctx(), conversationId, turnIndex);
	}

	listRecall(turnId: TurnId): TurnRecallEntry[] {
		return read.listRecall(this.ctx(), turnId);
	}

	listRecallByIndex(
		conversationId: ConversationId,
		turnIndex: number,
	): TurnRecallEntry[] {
		return read.listRecallByIndex(this.ctx(), conversationId, turnIndex);
	}

	listForks(conversationId: ConversationId): ConversationFork[] {
		return read.listForks(this.ctx(), conversationId);
	}

	countTurns(conversationId: ConversationId): number {
		return read.countTurns(this.ctx(), conversationId);
	}

	conversationStats(conversationId: ConversationId): ConversationStats {
		return read.conversationStats(this.ctx(), conversationId);
	}

	nextTurnIndexFor(conversationId: ConversationId): number {
		return read.nextTurnIndexFor(this.ctx(), conversationId);
	}

	// ── TurnWriter ──────────────────────────────────────────────

	appendTurn(entry: TurnEntry): TurnId {
		return write.appendTurn(this.ctx(), entry);
	}

	appendRecall(entry: TurnRecallEntry): void {
		write.appendRecall(this.ctx(), entry);
	}

	ensureConversationId(sessionId: SessionId): ConversationId {
		return write.ensureConversationId(this.ctx(), sessionId);
	}

	forkConversation(
		parentId: ConversationId,
		forkTurnIndex: number,
	): ConversationId {
		return write.forkConversation(this.ctx(), parentId, forkTurnIndex);
	}

	// ── TurnAdmin ───────────────────────────────────────────────

	prune(policy: RetentionPolicy): PruneReport {
		return admin.prune(this.ctx(), policy);
	}

	vacuum(): void {
		admin.vacuum(this.ctx());
	}

	checkpoint(): StoreSnapshot {
		return admin.checkpoint(this.ctx());
	}

	restore(from: StoreSnapshot): void {
		admin.restore(this.ctx(), from);
	}

	clear(): void {
		admin.clear(this.ctx());
	}

	stampTurnsEpoch(sessionId: SessionId, epochId: string): number {
		return admin.stampTurnsEpoch(this.ctx(), sessionId, epochId);
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
			nextTurnIndexFor: (id) => this.nextTurnIndexFor(id),
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
