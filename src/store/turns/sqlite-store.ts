/**
 * sqlite-store.ts — SqliteTurnStore: the reference implementation.
 *
 * Thin delegate shell: each method body lives as a free function in ./sqlite-store/*
 * (read.ts / write.ts / admin.ts) operating on an internal ctx ({db, stateDir,
 * opts}); this class wires those to the contract. The public API surface —
 * SqliteTurnStore implements TurnStore, all methods, asReader/asWriter/asAdmin,
 * close — is unchanged for existing callers.
 *
 * Private schema (SQL lives in the impl files + connection.ts, not in types.ts).
 * Append-only: no UPDATE on turns/turn_recall after INSERT (only in migration).
 *
 * PREVENT-PI-004: node:sqlite in-process only.
 * PREVENT-002: all queries use bound parameters.
 * PREVENT-001: safeJson not needed — no JSON columns in turns.db.
 */

import type { DatabaseSync } from "node:sqlite";
import { openTurnDb, closeTurnDb } from "./connection.js";
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
import type { SqliteTurnStoreCtx } from "./sqlite-store/ctx.js";
import * as read from "./sqlite-store/read.js";
import * as write from "./sqlite-store/write.js";
import * as admin from "./sqlite-store/admin.js";

export class SqliteTurnStore implements TurnStore {
	private db: DatabaseSync;
	private stateDir: string;
	private opts: TurnStoreOptions;

	constructor(options: TurnStoreOptions) {
		this.opts = options;
		this.stateDir = options.stateDir;
		this.db = openTurnDb(options.stateDir, {
			dbPath: options.dbPath,
			inMemory: options.inMemory,
		});
	}

	private ctx(): SqliteTurnStoreCtx {
		return { db: this.db, stateDir: this.stateDir, opts: this.opts };
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
		closeTurnDb(this.stateDir, {
			dbPath: this.opts.dbPath,
			inMemory: this.opts.inMemory,
		});
	}
}
