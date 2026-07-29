/**
 * turnStore.ts — S49 host-agnostic TurnStore factory.
 *
 * CRUD + fork logic ported from src/store/sqlite/turns.ts (S48), re-pointed at
 * the isolated turns.db (openTurnStore). Behavior is identical to S48 except:
 * conversation-id persistence moves OFF session_state (a main-db table) onto a
 * turns_meta key so the store is self-contained for reuse (R1). All queries
 * parameterized (PREVENT-002). Pure node:sqlite, no network (PREVENT-PI-004).
 */
import { randomBytes } from "node:crypto";
import { getStateDir, normalizeSessionId } from "../../store.js";
import { openTurnStore, closeTurnStore, withTx } from "./connection.js";
import type {
	ForkResult,
	PruneOptions,
	RecordTurnInput,
	RecordTurnRecallHit,
	TurnRecallRow,
	TurnRow,
	TurnStore,
} from "./types.js";

/** Generate a new conversation id (`conv_` + 16 hex). */
export function newConversationId(): string {
	return `conv_${randomBytes(8).toString("hex")}`;
}

function rowToTurn(r: Record<string, unknown>): TurnRow {
	return {
		id: r.id as number,
		conversationId: r.conversation_id as string,
		sessionId: r.session_id as string,
		turnIndex: r.turn_index as number,
		role: (r.role as string | null) ?? null,
		startedAt: r.started_at as number,
		endedAt: (r.ended_at as number | null) ?? null,
		ctxTokens: (r.ctx_tokens as number | null) ?? null,
		ctxPercent: (r.ctx_percent as number | null) ?? null,
		pressureBand: (r.pressure_band as string | null) ?? null,
		modelId: (r.model_id as string | null) ?? null,
		epochId: (r.epoch_id as string | null) ?? null,
	};
}

function rowToRecall(r: Record<string, unknown>): TurnRecallRow {
	return {
		id: r.id as number,
		turnId: r.turn_id as number,
		checkpointId: r.checkpoint_id as string,
		score: r.score as number,
		source: r.source as string,
		raptorLevel: (r.raptor_level as number | null) ?? null,
	};
}

/**
 * Create a TurnStore over an isolated turns.db for `stateDir`. Pi-agnostic —
 * the only input is a state directory. See docs/specs/s49-turn-db-foundation.md.
 */
export function createTurnStore(stateDir: string = getStateDir()): TurnStore {
	const db = openTurnStore(stateDir);

	function recordTurn(input: RecordTurnInput): number {
		const sid = normalizeSessionId(input.sessionId);
		const startedAt = input.startedAt ?? Date.now();
		db.prepare(
			`INSERT INTO turns (conversation_id, session_id, turn_index, role, started_at,
                           ended_at, ctx_tokens, ctx_percent, pressure_band, model_id, epoch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_index) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         role = COALESCE(excluded.role, role),
         started_at = COALESCE(excluded.started_at, started_at),
         ended_at = COALESCE(excluded.ended_at, ended_at),
         ctx_tokens = COALESCE(excluded.ctx_tokens, ctx_tokens),
         ctx_percent = COALESCE(excluded.ctx_percent, ctx_percent),
         pressure_band = COALESCE(excluded.pressure_band, pressure_band),
         model_id = COALESCE(excluded.model_id, model_id),
         epoch_id = COALESCE(excluded.epoch_id, epoch_id)`,
		).run(
			input.conversationId,
			sid,
			input.turnIndex,
			input.role ?? null,
			startedAt,
			input.endedAt ?? null,
			input.ctxTokens ?? null,
			input.ctxPercent ?? null,
			input.pressureBand ?? null,
			input.modelId ?? null,
			input.epochId ?? null,
		);
		const row = db
			.prepare("SELECT id FROM turns WHERE session_id = ? AND turn_index = ?")
			.get(sid, input.turnIndex) as { id: number };
		return row.id;
	}

	function recordTurnRecall(turnId: number, hits: RecordTurnRecallHit[]): void {
		if (hits.length === 0) return;
		const stmt = db.prepare(
			`INSERT INTO turn_recall (turn_id, checkpoint_id, score, source, raptor_level)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(turn_id, checkpoint_id) DO UPDATE SET
         score = excluded.score, source = excluded.source,
         raptor_level = excluded.raptor_level`,
		);
		withTx(db, () => {
			for (const h of hits) {
				stmt.run(
					turnId,
					h.checkpointId,
					h.score,
					h.source,
					h.raptorLevel ?? null,
				);
			}
		});
	}

	function getTurn(conversationId: string, turnIndex: number): TurnRow | null {
		const row = db
			.prepare(
				"SELECT * FROM turns WHERE conversation_id = ? AND turn_index = ?",
			)
			.get(conversationId, turnIndex) as Record<string, unknown> | undefined;
		return row ? rowToTurn(row) : null;
	}

	function getTurnById(turnId: number): TurnRow | null {
		const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToTurn(row) : null;
	}

	function listTurnRecall(turnId: number): TurnRecallRow[] {
		const rows = db
			.prepare(
				`SELECT id, turn_id, checkpoint_id, score, source, raptor_level
         FROM turn_recall WHERE turn_id = ? ORDER BY score DESC`,
			)
			.all(turnId) as Array<Record<string, unknown>>;
		return rows.map(rowToRecall);
	}

	function listConversationTurns(conversationId: string): TurnRow[] {
		const rows = db
			.prepare(
				"SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_index ASC",
			)
			.all(conversationId) as Array<Record<string, unknown>>;
		return rows.map(rowToTurn);
	}

	// R1: conversation-id persistence moved OFF session_state onto turns_meta so
	// the store is self-contained (no main-db dependency) for reuse hosts.
	function ensureConversationId(sessionId: string): string {
		const sid = normalizeSessionId(sessionId);
		const key = `conv_${sid}`;
		const existing = db
			.prepare("SELECT value FROM turns_meta WHERE key = ?")
			.get(key) as { value: string } | undefined;
		if (existing) return existing.value;
		const conv = newConversationId();
		db.prepare("INSERT INTO turns_meta (key, value) VALUES (?, ?)").run(
			key,
			conv,
		);
		return conv;
	}

	function forkConversation(
		parentConversationId: string,
		forkTurnId: number,
	): ForkResult {
		const childId = newConversationId();
		withTx(db, () => {
			db.prepare(
				`INSERT INTO conversation_branches
           (conversation_id, parent_conversation_id, fork_turn_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO NOTHING`,
			).run(childId, parentConversationId, forkTurnId, Date.now());
		});
		// Replay set: the parent's injected checkpoints at the fork turn.
		return { conversationId: childId, recalled: listTurnRecall(forkTurnId) };
	}

	function stampTurnsEpoch(sessionId: string, epochId: string): number {
		const sid = normalizeSessionId(sessionId);
		const res = db
			.prepare("UPDATE turns SET epoch_id = ? WHERE session_id = ? AND epoch_id IS NULL")
			.run(epochId, sid);
		return Number(res.changes ?? 0);
	}

	function clearTurns(sessionId: string): void {
		const sid = normalizeSessionId(sessionId);
		withTx(db, () => {
			const turnIds = db
				.prepare("SELECT id FROM turns WHERE session_id = ?")
				.all(sid) as Array<{ id: number }>;
			const ids = turnIds.map((t) => t.id);
			if (ids.length > 0) {
				const placeholders = ids.map(() => "?").join(",");
				db.prepare(
					`DELETE FROM turn_recall WHERE turn_id IN (${placeholders})`,
				).run(...ids);
			}
			db.prepare("DELETE FROM turns WHERE session_id = ?").run(sid);
		});
	}

	function pruneTurns(opts: PruneOptions): {
		deletedTurns: number;
		deletedRecall: number;
	} {
		const now = opts.now ?? Date.now();
		const cutoff = now - opts.olderThanMs;
		// Delete recall + turns older than cutoff, EXCEPT each conversation's most
		// recent keepMinPerConversation turns and any turn that is a fork point
		// (referenced by conversation_branches.fork_turn_id — preserves lineage).
		let deletedRecall = 0;
		let deletedTurns = 0;
		withTx(db, () => {
			const candidates = db
				.prepare(
					`SELECT t.id FROM turns t
           WHERE t.ended_at < ?
             AND t.id NOT IN (SELECT fork_turn_id FROM conversation_branches)
             AND t.id NOT IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                   PARTITION BY conversation_id ORDER BY turn_index DESC
                 ) AS rn
                 FROM turns
               ) WHERE rn <= ?
             )`,
				)
				.all(cutoff, opts.keepMinPerConversation) as Array<{ id: number }>;
			const ids = candidates.map((c) => c.id);
			if (ids.length === 0) return;
			const ph = ids.map(() => "?").join(",");
			const r1 = db
				.prepare(`DELETE FROM turn_recall WHERE turn_id IN (${ph})`)
				.run(...ids);
			const r2 = db
				.prepare(`DELETE FROM turns WHERE id IN (${ph})`)
				.run(...ids);
			deletedRecall = Number(r1.changes ?? 0);
			deletedTurns = Number(r2.changes ?? 0);
		});
		return { deletedTurns, deletedRecall };
	}

	function vacuum(): void {
		db.exec("VACUUM");
	}

	function close(): void {
		closeTurnStore(stateDir);
	}

	return {
		recordTurn,
		recordTurnRecall,
		getTurn,
		getTurnById,
		listTurnRecall,
		listConversationTurns,
		ensureConversationId,
		forkConversation,
		stampTurnsEpoch,
		clearTurns,
		pruneTurns,
		vacuum,
		close,
	};
}
