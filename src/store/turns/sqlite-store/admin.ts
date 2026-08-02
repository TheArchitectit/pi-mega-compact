/**
 * admin.ts — TurnAdmin method bodies (extracted from sqlite-store.ts). All
 * queries use bound parameters (PREVENT-002). DELETE/UPDATE only here (the
 * append-only rule applies to turns/turn_recall writes outside migrations).
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type {
	SessionId,
	PruneReport,
	RetentionPolicy,
	StoreSnapshot,
	TurnRecallEntry,
} from "../types.js";
import type { SqliteTurnStoreCtx } from "./ctx.js";
import { normalizeSessionId, rowToEntry, rowToFork } from "./rows.js";

export function prune(ctx: SqliteTurnStoreCtx, policy: RetentionPolicy): PruneReport {
	const { db } = ctx;
	const beforeSize = dbSizeBytes(ctx);
	const cutoff = Date.now() - policy.maxTurnAgeMs;

	// Find conversations with turns to potentially prune
	const convRows = db
		.prepare("SELECT DISTINCT conversation_id FROM turns")
		.all() as Array<{ conversation_id: string }>;

	let turnsRemoved = 0;
	let recallRemoved = 0;

	for (const { conversation_id } of convRows) {
		// Count total turns in this conversation
		const total = db
			.prepare("SELECT COUNT(*) as cnt FROM turns WHERE conversation_id = ?")
			.get(conversation_id) as { cnt: number };

		// Keep at least keepMinPerConversation — delete only the oldest
		const canDelete = Math.max(0, total.cnt - policy.keepMinPerConversation);
		if (canDelete === 0) continue;

		// Find old turns to delete
		const oldTurns = db
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
		const delRecall = db
			.prepare(`DELETE FROM turn_recall WHERE turn_id IN (${placeholders})`)
			.run(...ids);
		recallRemoved += Number(delRecall.changes);

		// Delete the turns
		const delTurns = db
			.prepare(`DELETE FROM turns WHERE id IN (${placeholders})`)
			.run(...ids);
		turnsRemoved += Number(delTurns.changes);
	}

	// Count preserved branches
	const branchesPreserved = (
		db
			.prepare("SELECT COUNT(*) as cnt FROM conversation_forks")
			.get() as { cnt: number }
	).cnt;

	if (policy.vacuumAfterPrune && (turnsRemoved > 0 || recallRemoved > 0)) {
		vacuum(ctx);
	}

	const afterSize = dbSizeBytes(ctx);

	return {
		turnsRemoved,
		recallRemoved,
		branchesPreserved,
		freedBytes: Math.max(0, beforeSize - afterSize),
	};
}

export function vacuum(ctx: SqliteTurnStoreCtx): void {
	ctx.db.exec("VACUUM");
}

export function checkpoint(ctx: SqliteTurnStoreCtx): StoreSnapshot {
	const { db } = ctx;
	// Query turns in row-id order (ended_at ASC with unique constraint)
	const turnRows = db
		.prepare("SELECT * FROM turns ORDER BY ended_at ASC")
		.all() as Array<Record<string, unknown>>;
	const turns = turnRows.map(rowToEntry);

	// Build mapping: row_id → 1-based position in turns array
	const rowIdToPos = new Map<number, number>();
	for (let i = 0; i < turnRows.length; i++) {
		rowIdToPos.set(turnRows[i].id as number, i + 1);
	}

	const recallRows = db
		.prepare("SELECT * FROM turn_recall ORDER BY turn_id ASC")
		.all() as Array<Record<string, unknown>>;

	// Replace recall's turnId with the 1-based position of the referenced turn
	// in the turns array. This makes the TurnId stable across restore.
	const recall = recallRows.map((r) => {
		const originalTurnId = r.turn_id as number;
		const stableTurnId = rowIdToPos.get(originalTurnId) ?? originalTurnId;
		return {
			turnId: String(stableTurnId),
			checkpointId: r.checkpoint_id as string,
			score: r.score as number,
			source: r.source as TurnRecallEntry["source"],
			raptorLevel: (r.raptor_level as number | null) ?? undefined,
		};
	});

	const forks = (
		db
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

export function restore(ctx: SqliteTurnStoreCtx, from: StoreSnapshot): void {
	const { db } = ctx;
	clear(ctx);
	const insertTurn = db.prepare(
		`INSERT INTO turns (conversation_id, session_id, turn_index, role, ended_at,
	                               ctx_tokens, ctx_percent, pressure_band, model, epoch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertRecall = db.prepare(
		`INSERT INTO turn_recall (turn_id, checkpoint_id, score, source, raptor_level)
       VALUES (?, ?, ?, ?, ?)`,
	);
	const insertFork = db.prepare(
		`INSERT INTO conversation_forks (parent_conversation_id, child_conversation_id, fork_turn_index, created_at)
       VALUES (?, ?, ?, ?)`,
	);

	db.exec("BEGIN TRANSACTION");
	try {
		// Map: 1-based position → new auto-increment row ID
		const posToNewId = new Map<number, number>();

		for (let i = 0; i < from.turns.length; i++) {
			const t = from.turns[i];
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
				t.epochId ?? null,
			);
			const row = db
				.prepare(
					"SELECT id FROM turns WHERE conversation_id = ? AND turn_index = ?",
				)
				.get(t.conversationId, t.turnIndex) as { id: number } | undefined;
			if (row) posToNewId.set(i + 1, row.id);
		}

		// Recall's turnId is now the 1-based position from checkpoint().
		// Map it to the new row ID.
		for (const r of from.recall) {
			const targetTurnId =
				posToNewId.get(Number(r.turnId)) ?? Number(r.turnId);
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
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

export function clear(ctx: SqliteTurnStoreCtx): void {
	const { db } = ctx;
	db.exec("DELETE FROM turn_recall");
	db.exec("DELETE FROM conversation_forks");
	db.exec("DELETE FROM turns");
	db.exec("DELETE FROM session_conversations");
	// Reset autoincrement
	db.exec(
		"DELETE FROM sqlite_sequence WHERE name IN ('turns','turn_recall','conversation_forks')",
	);
}

export function stampTurnsEpoch(
	ctx: SqliteTurnStoreCtx,
	sessionId: SessionId,
	epochId: string,
): number {
	const { db } = ctx;
	const sid = normalizeSessionId(sessionId);
	const res = db
		.prepare(
			"UPDATE turns SET epoch_id = ? WHERE session_id = ? AND epoch_id IS NULL",
		)
		.run(epochId, sid);
	return Number(res.changes ?? 0);
}

function dbSizeBytes(ctx: SqliteTurnStoreCtx): number {
	if (ctx.opts.inMemory) return 0;
	try {
		const path = ctx.opts.dbPath ?? join(ctx.stateDir, "turns.db");
		return statSync(path).size;
	} catch {
		return 0;
	}
}
