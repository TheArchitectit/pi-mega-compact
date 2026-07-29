/**
 * intent.ts — S52A host-agnostic rewind-intent queue.
 *
 * A thin queue over the S49-pre-created `pending_fork` table. The dashboard
 * (or any external surface) POSTS a "rewind to turn N" intent; the host polls
 * pending intents at `before_agent_start` and CONSUMEs them to apply the rewind.
 * The store never calls back into the host (ledger protocol — the host PUSHES
 * facts and PULLS views; the store is passive).
 *
 * State is encoded on `consumed_at` (NULL = pending, non-NULL = consumed) +
 * row absence (abandoned = deleted). No schema change to `pending_fork`.
 *
 * Pi-agnostic (PREVENT-PI-004: pure node:sqlite). Parameterized (PREVENT-002).
 */
import type { DatabaseSync } from "node:sqlite";

/** A rewind intent — "rewind conversation X to turn N". */
export interface RewindIntent {
	/** Stable string id (random 16-hex). */
	id: string;
	/** Conversation to rewind. */
	conversationId: string;
	/** The turn index to rewind to (the parent turn a fork branches from). */
	targetTurnIndex: number;
	/** epoch ms the intent was posted. */
	createdAt: number;
	/** pending (not yet acted on) | consumed (host applied it). */
	status: "pending" | "consumed";
}

/** Input to postIntent (id/createdAt/status are derived). */
export interface PostIntentInput {
	conversationId: string;
	targetTurnIndex: number;
}

/** Append-only writer for rewind intents (dashboard / external surface). */
export interface IntentWriter {
	postIntent(input: PostIntentInput): RewindIntent;
}

/** Reader for rewind intents (host polls; dashboard inspects). */
export interface IntentReader {
	pendingIntents(): RewindIntent[];
	allIntents(limit?: number): RewindIntent[];
	consumeIntent(id: string): void;
	/** Abandon = delete (the intent is withdrawn, never to be applied). */
	abandonIntent(id: string): void;
}

/** Open an intent queue over a turns.db handle (from openTurnStore/openTurnDb). */
export function openIntentQueue(db: DatabaseSync): IntentWriter & IntentReader {
	function rowToIntent(r: Record<string, unknown>): RewindIntent {
		return {
			id: String(r.id),
			conversationId: String(r.target_conversation_id),
			targetTurnIndex: Number(r.target_turn_id),
			createdAt: Number(r.requested_at),
			status: r.consumed_at == null ? "pending" : "consumed",
		};
	}

	return {
		postIntent(input: PostIntentInput): RewindIntent {
			const createdAt = Date.now();
			const res = db
				.prepare(
					`INSERT INTO pending_fork
           (target_conversation_id, target_turn_id, requested_at, consumed_at)
         VALUES (?, ?, ?, NULL)`,
				)
				.run(input.conversationId, input.targetTurnIndex, createdAt);
			const id = String(Number(res.lastInsertRowid));
			return {
				id,
				conversationId: input.conversationId,
				targetTurnIndex: input.targetTurnIndex,
				createdAt,
				status: "pending",
			};
		},

		pendingIntents(): RewindIntent[] {
			const rows = db
				.prepare(
					`SELECT id, target_conversation_id, target_turn_id, requested_at, consumed_at
           FROM pending_fork WHERE consumed_at IS NULL
           ORDER BY requested_at ASC`,
				)
				.all() as Array<Record<string, unknown>>;
			return rows.map(rowToIntent);
		},

		allIntents(limit = 100): RewindIntent[] {
			const rows = db
				.prepare(
					`SELECT id, target_conversation_id, target_turn_id, requested_at, consumed_at
           FROM pending_fork ORDER BY requested_at DESC, id DESC LIMIT ?`,
				)
				.all(limit) as Array<Record<string, unknown>>;
			return rows.map(rowToIntent);
		},

		consumeIntent(id: string): void {
			db.prepare("UPDATE pending_fork SET consumed_at = ? WHERE id = ?").run(
				Date.now(),
				id,
			);
		},

		abandonIntent(id: string): void {
			db.prepare("DELETE FROM pending_fork WHERE id = ?").run(id);
		},
	};
}
