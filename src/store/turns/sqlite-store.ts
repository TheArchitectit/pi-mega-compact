/**
 * sqlite-store.ts — SqliteTurnStore: the reference implementation.
 *
 * Private schema (SQL lives here + connection.ts, not in types.ts).
 * All methods satisfy the TurnStore contract from types.ts.
 * Append-only: no UPDATE on turns/turn_recall after INSERT (only in migration).
 *
 * PREVENT-PI-004: node:sqlite in-process only.
 * PREVENT-002: all queries use bound parameters.
 * PREVENT-001: safeJson not needed — no JSON columns in turns.db.
 */

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
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

// ─── Helpers ──────────────────────────────────────────────────────

function newConversationId(): ConversationId {
	return `conv_${randomBytes(8).toString("hex")}`;
}

function normalizeSessionId(sid: SessionId): SessionId {
	// Matches the existing normalizeSessionId in src/store.ts
	return sid.replace(/-.*$/, "");
}

function rowToEntry(r: Record<string, unknown>): TurnEntry {
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
	};
}

function rowToRecall(r: Record<string, unknown>): TurnRecallEntry {
	return {
		turnId: String(r.turn_id),
		checkpointId: r.checkpoint_id as string,
		score: r.score as number,
		source: r.source as TurnRecallEntry["source"],
		raptorLevel: (r.raptor_level as number | null) ?? undefined,
	};
}

function rowToFork(r: Record<string, unknown>): ConversationFork {
	return {
		parentConversationId: r.parent_conversation_id as string,
		childConversationId: r.child_conversation_id as string,
		forkTurnIndex: r.fork_turn_index as number,
		createdAt: r.created_at as number,
	};
}

// ─── SqliteTurnStore ──────────────────────────────────────────────

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

	// ── TurnReader ──────────────────────────────────────────────

	query(filter: TurnFilter): TurnEntry[] {
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

		const rows = this.db
			.prepare(
				`SELECT * FROM turns ${where} ORDER BY ended_at ASC LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as Array<Record<string, unknown>>;

		return rows.map(rowToEntry);
	}

	getTurn(turnId: TurnId): TurnEntry | undefined {
		const row = this.db
			.prepare("SELECT * FROM turns WHERE id = ?")
			.get(Number(turnId)) as Record<string, unknown> | undefined;
		return row ? rowToEntry(row) : undefined;
	}

	listRecall(turnId: TurnId): TurnRecallEntry[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM turn_recall WHERE turn_id = ? ORDER BY score DESC",
			)
			.all(Number(turnId)) as Array<Record<string, unknown>>;
		return rows.map(rowToRecall);
	}

	listForks(conversationId: ConversationId): ConversationFork[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM conversation_forks WHERE parent_conversation_id = ? ORDER BY created_at ASC",
			)
			.all(conversationId) as Array<Record<string, unknown>>;
		return rows.map(rowToFork);
	}

	countTurns(conversationId: ConversationId): number {
		const row = this.db
			.prepare("SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ?")
			.get(conversationId) as { cnt: number };
		return row.cnt;
	}

	conversationStats(conversationId: ConversationId): ConversationStats {
		const rows = this.db
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

	// ── TurnWriter ──────────────────────────────────────────────

	appendTurn(entry: TurnEntry): TurnId {
		const sid = normalizeSessionId(entry.sessionId);
		this.db
			.prepare(
				`INSERT INTO turns (conversation_id, session_id, turn_index, role, ended_at,
                                   ctx_tokens, ctx_percent, pressure_band, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			);
		const row = this.db
			.prepare(
				"SELECT id FROM turns WHERE conversation_id = ? AND turn_index = ?",
			)
			.get(entry.conversationId, entry.turnIndex) as { id: number } | undefined;
		return String(row!.id);
	}

	appendRecall(entry: TurnRecallEntry): void {
		this.db
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

	ensureConversationId(sessionId: SessionId): ConversationId {
		const sid = normalizeSessionId(sessionId);
		// Check if any turn exists for this session
		const row = this.db
			.prepare(
				"SELECT conversation_id FROM turns WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1",
			)
			.get(sid) as { conversation_id: string } | undefined;
		if (row) return row.conversation_id;
		// No turns yet — create a new conversation id
		return newConversationId();
	}

	forkConversation(
		parentId: ConversationId,
		forkTurnIndex: number,
	): ConversationId {
		const childId = newConversationId();
		this.db
			.prepare(
				`INSERT INTO conversation_forks (parent_conversation_id, child_conversation_id, fork_turn_index, created_at)
         VALUES (?, ?, ?, ?)`,
			)
			.run(parentId, childId, forkTurnIndex, Date.now());

		// The fork records the lineage. The child inherits the parent's
		// recall by querying listRecall on the parent's turn — no duplication.

		return childId;
	}

	// ── TurnAdmin ───────────────────────────────────────────────

	prune(policy: RetentionPolicy): PruneReport {
		const beforeSize = this.dbSizeBytes();
		const cutoff = Date.now() - policy.maxTurnAgeMs;

		// Find conversations with turns to potentially prune
		const convRows = this.db
			.prepare("SELECT DISTINCT conversation_id FROM turns")
			.all() as Array<{ conversation_id: string }>;

		let turnsRemoved = 0;
		let recallRemoved = 0;

		for (const { conversation_id } of convRows) {
			// Count total turns in this conversation
			const total = this.db
				.prepare("SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ?")
				.get(conversation_id) as { cnt: number };

			// Keep at least keepMinPerConversation — delete only the oldest
			const canDelete = Math.max(0, total.cnt - policy.keepMinPerConversation);
			if (canDelete === 0) continue;

			// Find old turns to delete
			const oldTurns = this.db
				.prepare(
					`SELECT id FROM turns WHERE conversation_id = ? AND ended_at < ?
           ORDER BY ended_at ASC LIMIT ?`,
				)
				.all(conversation_id, cutoff, canDelete) as Array<{
				id: number;
			}>;

			if (oldTurns.length === 0) continue;

			const ids = oldTurns.map((t) => t.id);
			const placeholders = ids.map(() => "?").join(",");

			// Delete recall for those turns
			const delRecall = this.db
				.prepare(`DELETE FROM turn_recall WHERE turn_id IN (${placeholders})`)
				.run(...ids);
			recallRemoved += Number(delRecall.changes);

			// Delete the turns
			const delTurns = this.db
				.prepare(`DELETE FROM turns WHERE id IN (${placeholders})`)
				.run(...ids);
			turnsRemoved += Number(delTurns.changes);
		}

		// Count preserved branches
		const branchesPreserved = (
			this.db
				.prepare("SELECT COUNT(*) as cnt FROM conversation_forks")
				.get() as { cnt: number }
		).cnt;

		if (policy.vacuumAfterPrune && (turnsRemoved > 0 || recallRemoved > 0)) {
			this.vacuum();
		}

		const afterSize = this.dbSizeBytes();

		return {
			turnsRemoved,
			recallRemoved,
			branchesPreserved,
			freedBytes: Math.max(0, beforeSize - afterSize),
		};
	}

	vacuum(): void {
		this.db.exec("VACUUM");
	}

	checkpoint(): StoreSnapshot {
		const turns = (
			this.db
				.prepare("SELECT * FROM turns ORDER BY ended_at ASC")
				.all() as Array<Record<string, unknown>>
		).map(rowToEntry);

		const recall = (
			this.db
				.prepare("SELECT * FROM turn_recall ORDER BY turn_id ASC")
				.all() as Array<Record<string, unknown>>
		).map(rowToRecall);

		const forks = (
			this.db
				.prepare("SELECT * FROM conversation_forks ORDER BY created_at ASC")
				.all() as Array<Record<string, unknown>>
		).map(rowToFork);

		return {
			version: 1,
			exportedAt: Date.now(),
			turns,
			recall,
			forks,
		};
	}

	restore(from: StoreSnapshot): void {
		this.clear();
		const insertTurn = this.db.prepare(
			`INSERT INTO turns (conversation_id, session_id, turn_index, role, ended_at,
                               ctx_tokens, ctx_percent, pressure_band, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertRecall = this.db.prepare(
			`INSERT INTO turn_recall (turn_id, checkpoint_id, score, source, raptor_level)
       VALUES (?, ?, ?, ?, ?)`,
		);
		const insertFork = this.db.prepare(
			`INSERT INTO conversation_forks (parent_conversation_id, child_conversation_id, fork_turn_index, created_at)
       VALUES (?, ?, ?, ?)`,
		);

		this.db.exec("BEGIN TRANSACTION");
		try {
			for (const t of from.turns) {
				insertTurn.run(
					t.conversationId,
					normalizeSessionId(t.sessionId),
					t.turnIndex,
					t.role,
					t.endedAt,
					t.ctxTokens ?? null,
					t.ctxPercent ?? null,
					t.pressureBand ?? null,
					t.model ?? null,
				);
			}

			// For recall, we need the snapshot's turnId → new row id mapping.
			// Since snapshot turnIds are "1", "2", etc. matching insertion order,
			// and we inserted turns in the same order, we can map by position.
			const sortedOldIds = from.turns.map((_, i) => i + 1);
			const newTurnIds = (
				this.db.prepare("SELECT id FROM turns ORDER BY id ASC").all() as Array<{
					id: number;
				}>
			).map((r) => r.id);
			const idRemap = new Map<number, number>();
			for (let i = 0; i < sortedOldIds.length && i < newTurnIds.length; i++) {
				idRemap.set(sortedOldIds[i], newTurnIds[i]);
			}

			for (const r of from.recall) {
				const targetTurnId = idRemap.get(Number(r.turnId)) ?? Number(r.turnId);
				insertRecall.run(
					targetTurnId,
					r.checkpointId,
					r.score,
					r.source,
					r.raptorLevel ?? null,
				);
			}
			for (const f of from.forks) {
				insertFork.run(
					f.parentConversationId,
					f.childConversationId,
					f.forkTurnIndex,
					f.createdAt,
				);
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	clear(): void {
		this.db.exec("DELETE FROM turn_recall");
		this.db.exec("DELETE FROM conversation_forks");
		this.db.exec("DELETE FROM turns");
		// Reset autoincrement
		this.db.exec(
			"DELETE FROM sqlite_sequence WHERE name IN ('turns','turn_recall','conversation_forks')",
		);
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
		closeTurnDb(this.stateDir, {
			dbPath: this.opts.dbPath,
			inMemory: this.opts.inMemory,
		});
	}

	// ── Private helpers ─────────────────────────────────────────

	private dbSizeBytes(): number {
		if (this.opts.inMemory) return 0;
		try {
			const path = this.opts.dbPath ?? join(this.stateDir, "turns.db");
			return statSync(path).size;
		} catch {
			return 0;
		}
	}
}
