/**
 * turns.ts — S50C per-turn + per-conversation memory-quality rollups.
 *
 * Host-agnostic (pi-agnostic): consumes the S49 `TurnStore` interface plus a
 * main-db `DatabaseSync` handle for raw_transcript / checkpoint_epochs. Pure
 * read queries — this module NEVER mutates memory, drop ranges, or compaction
 * (PREVENT-PI-001/002). Parameterized (PREVENT-002). No network (PREVENT-PI-004).
 *
 * These are the numbers the S52 dashboard Turns tab renders: per-turn cache-hit
 * (recall reuse), dedup ratio, and compression ratio, rolled up per turn and
 * per conversation.
 */
import type { DatabaseSync } from "node:sqlite";
import type { TurnStore } from "../store/turns/types.js";

/** Per-turn memory-quality metrics. Ratios are 0 when their basis is absent. */
export interface TurnMetrics {
	/** Per-conversation turn key (the contract TurnEntry is id-less; turnIndex
	 *  is unique within a conversation). */
	turnId: number;
	conversationId: string;
	sessionId: string;
	turnIndex: number;
	epochId: string | null;
	ctxTokens: number | null;
	ctxPercent: number | null;
	/** Checkpoints/summaries injected this turn (turn_recall count). */
	recallCount: number;
	/** Raw messages mirrored for this turn (raw_transcript.turn_index count). 0 when dbMirror OFF. */
	rawMessageCount: number;
	/** Distinct content_hash / raw rows for this turn → 1 - ratio = dup fraction. */
	dedupUniqueRatio: number;
	/** Raw bytes → summary bytes compression for the epoch this turn closed (0 if none). */
	compressionRatio: number;
}

/** Per-conversation aggregate of TurnMetrics. */
export interface ConversationMetrics {
	conversationId: string;
	turnCount: number;
	totalRecall: number;
	totalRawMessages: number;
	avgDedupUniqueRatio: number;
	avgCompressionRatio: number;
	/** Distinct epochs that compacted this conversation's turns. */
	epochCount: number;
}

interface RawAgg {
	turn_index: number;
	raw_count: number;
	unique_count: number;
}

/** Approximate byte length of a text (utf8). */
function byteLen(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

/**
 * Per-turn metrics for a conversation. Combines turns.db (turn spine + recall)
 * with main-db raw_transcript (dedup) + checkpoint_epochs (compression).
 *
 * `mainDb` may be a store without raw_transcript/checkpoint_epochs (e.g. a
 * reuse host that only mirrors turns); in that case dedup/compression = 0 and
 * rawMessageCount = 0. Detected defensively per-query.
 */
export function turnMetrics(
	store: TurnStore,
	mainDb: DatabaseSync,
	conversationId: string,
): TurnMetrics[] {
	const turns = store.query({ conversationId, limit: 10000 });
	if (turns.length === 0) return [];

	const hasRaw = tableExists(mainDb, "raw_transcript");
	const hasEpoch = tableExists(mainDb, "checkpoint_epochs");

	// Aggregate raw_transcript per turn_index for this session (raw rows + unique
	// content_hash). Grouped by turn_index; sessions may share turn_index values,
	// so we scope by session_id below per turn.
	const rawAggBySessionTurn = new Map<string, RawAgg>();
	if (hasRaw) {
		const sessionIds = [...new Set(turns.map((t) => t.sessionId))];
		const placeholders = sessionIds.map(() => "?").join(",");
		const rows = mainDb
			.prepare(
				`SELECT session_id, turn_index,
                COUNT(*) AS raw_count,
                COUNT(DISTINCT content_hash) AS unique_count
         FROM raw_transcript
         WHERE session_id IN (${placeholders}) AND turn_index IS NOT NULL
         GROUP BY session_id, turn_index`,
			)
			.all(...sessionIds) as unknown as Array<RawAgg & { session_id: string }>;
		for (const r of rows) {
			rawAggBySessionTurn.set(`${r.session_id}::${r.turn_index}`, r);
		}
	}

	// Compression ratio per epoch: committed raw bytes → summary bytes. Precomputed
	// per epoch referenced by any turn.
	const compressionByEpoch = new Map<string, number>();
	if (hasEpoch) {
		const epochIds = turns
			.map((t) => t.epochId)
			.filter((e): e is string => e != null);
		for (const eid of new Set(epochIds)) {
			const ratio = epochCompressionRatio(mainDb, eid);
			if (ratio != null) compressionByEpoch.set(eid, ratio);
		}
	}

	return turns.map((t) => {
		const recall = store.listRecallByIndex(conversationId, t.turnIndex);
		// S49R: raw_transcript is keyed by pi's per-session counter. Pre-migration
		// turn rows have NULL sessionTurnIndex and their turnIndex IS the session
		// counter, so fall back to turnIndex (COALESCE). Post-migration rows join
		// on sessionTurnIndex so resume doesn't zero the raw message count.
		const sessionKey = t.sessionTurnIndex ?? t.turnIndex;
		const agg = rawAggBySessionTurn.get(`${t.sessionId}::${sessionKey}`);
		const rawCount = agg?.raw_count ?? 0;
		const uniqueCount = agg?.unique_count ?? 0;
		return {
			turnId: t.turnIndex,
			conversationId: t.conversationId,
			sessionId: t.sessionId,
			turnIndex: t.turnIndex,
			epochId: t.epochId ?? null,
			ctxTokens: t.ctxTokens ?? null,
			ctxPercent: t.ctxPercent ?? null,
			recallCount: recall.length,
			rawMessageCount: rawCount,
			dedupUniqueRatio: rawCount > 0 ? uniqueCount / rawCount : 0,
			compressionRatio: t.epochId
				? (compressionByEpoch.get(t.epochId) ?? 0)
				: 0,
		};
	});
}

/** Aggregate a conversation's per-turn metrics. */
export function conversationMetrics(
	store: TurnStore,
	mainDb: DatabaseSync,
	conversationId: string,
): ConversationMetrics {
	const perTurn = turnMetrics(store, mainDb, conversationId);
	const turnCount = perTurn.length;
	const totalRecall = perTurn.reduce((s, t) => s + t.recallCount, 0);
	const totalRaw = perTurn.reduce((s, t) => s + t.rawMessageCount, 0);
	const dedupSum = perTurn.reduce((s, t) => s + t.dedupUniqueRatio, 0);
	const compSum = perTurn.reduce((s, t) => s + t.compressionRatio, 0);
	const epochs = new Set(perTurn.map((t) => t.epochId).filter(Boolean));
	return {
		conversationId,
		turnCount,
		totalRecall,
		totalRawMessages: totalRaw,
		avgDedupUniqueRatio: turnCount > 0 ? dedupSum / turnCount : 0,
		avgCompressionRatio: turnCount > 0 ? compSum / turnCount : 0,
		epochCount: epochs.size,
	};
}

function tableExists(db: DatabaseSync, name: string): boolean {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
			.get(name) !== undefined
	);
}

/**
 * Compression ratio for an epoch: summaryMessageText bytes ÷ raw bytes of the
 * committed range. Returns null when the epoch or its raw rows are absent.
 * Ratio < 1 means compression shrank the content (lower = more compression).
 */
function epochCompressionRatio(
	mainDb: DatabaseSync,
	epochId: string,
): number | null {
	const epoch = mainDb
		.prepare(
			"SELECT session_id, committed_seq, summary_message_text FROM checkpoint_epochs WHERE epoch_id = ?",
		)
		.get(epochId) as
		| {
				session_id: string;
				committed_seq: number;
				summary_message_text: string;
		  }
		| undefined;
	if (!epoch) return null;
	const raw = mainDb
		.prepare(
			`SELECT COALESCE(SUM(LENGTH(content_bytes)), 0) AS bytes
       FROM raw_transcript
       WHERE session_id = ? AND seq <= ?`,
		)
		.get(epoch.session_id, epoch.committed_seq) as { bytes: number };
	const rawBytes = raw?.bytes ?? 0;
	if (rawBytes <= 0) return null;
	const summaryBytes = byteLen(epoch.summary_message_text ?? "");
	return summaryBytes / rawBytes;
}
