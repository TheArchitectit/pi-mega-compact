/**
 * turns.ts — S43 per-turn vector + conversation tracking.
 *
 * The relational spine for per-turn + per-conversation memories:
 *   - `turns`: one row per turn_end (metrics + epoch link + conversation id)
 *   - `turn_recall`: which checkpoints/cluster summaries were injected at a turn
 *   - `conversation_branches`: fork registry (parent → child at a turn point)
 *
 * `conversationId` (on SessionState) groups turns across pi session resumes;
 * `/clear` or any fresh root generates a new one via `newConversationId()`.
 *
 * `forkConversation(parent, forkTurnId)` copies a parent conversation's
 * recall state at `forkTurnId` into a fresh conversation's injected-set, so a
 * forked session starts with exactly the context conversation X had at turn N
 * (a recall-fork, not a live-window replay — see docs/specs/s43-per-turn-vector-tracking.md).
 *
 * No network. Pure SQLite (PREVENT-PI-004). All queries parameterized (PREVENT-002).
 */

import { randomBytes } from "node:crypto";
import { openStore, withTx } from "./utils.js";
import { getStateDir, normalizeSessionId } from "../../store.js";
import { loadSessionState, saveSessionState } from "./session-state.js";
import type { DatabaseSync } from "node:sqlite";

/** A row in `turns`. */
export interface TurnRow {
  id: number;
  conversationId: string;
  sessionId: string;
  turnIndex: number;
  role: string | null;
  startedAt: number;
  endedAt: number | null;
  ctxTokens: number | null;
  ctxPercent: number | null;
  pressureBand: string | null;
  modelId: string | null;
  epochId: string | null;
}

/** A row in `turn_recall`. */
export interface TurnRecallRow {
  id: number;
  turnId: number;
  checkpointId: string;
  score: number;
  source: string;
  raptorLevel: number | null;
}

/** Where a recalled hit came from (recorded on turn_recall.source). */
export type RecallSource = "flat" | "raptor" | "cross-repo" | "memory";

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

/**
 * Upsert a turn row at turn_end. Returns the turn id. `startedAt` defaults to
 * now (the turn_start write can update it; turn_end sets ended_at + metrics).
 * Idempotent on (session_id, turn_index) — re-upserting overwrites metrics.
 */
export function recordTurn(
  input: {
    conversationId: string;
    sessionId: string;
    turnIndex: number;
    role?: string;
    startedAt?: number;
    endedAt?: number;
    ctxTokens?: number;
    ctxPercent?: number;
    pressureBand?: string;
    modelId?: string;
    epochId?: string;
  },
  stateDir: string = getStateDir(),
): number {
  const db = openStore(stateDir);
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

/**
 * Record what was recalled at a turn. Called from recallAndInline with the
 * resolved toInject list — each hit becomes a turn_recall row with its source
 * path + score. RAPTOR cluster hits carry raptorLevel. Best-effort + non-fatal.
 */
export function recordTurnRecall(
  turnId: number,
  hits: {
    checkpointId: string;
    score: number;
    source: RecallSource;
    raptorLevel?: number;
  }[],
  stateDir: string = getStateDir(),
): void {
  if (hits.length === 0) return;
  const db = openStore(stateDir);
  const stmt = db.prepare(
    `INSERT INTO turn_recall (turn_id, checkpoint_id, score, source, raptor_level)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(turn_id, checkpoint_id) DO UPDATE SET
       score = excluded.score, source = excluded.source,
       raptor_level = excluded.raptor_level`,
  );
  withTx(db, () => {
    for (const h of hits) {
      stmt.run(turnId, h.checkpointId, h.score, h.source, h.raptorLevel ?? null);
    }
  });
}

/** Get a turn by conversation id + turn index (the lookup a fork uses). */
export function getTurn(
  conversationId: string,
  turnIndex: number,
  stateDir: string = getStateDir(),
): TurnRow | null {
  const db = openStore(stateDir);
  const row = db
    .prepare(
      `SELECT * FROM turns WHERE conversation_id = ? AND turn_index = ?`,
    )
    .get(conversationId, turnIndex) as Record<string, unknown> | undefined;
  return row ? rowToTurn(row) : null;
}

/** Get a turn by its global id. */
export function getTurnById(
  turnId: number,
  stateDir: string = getStateDir(),
): TurnRow | null {
  const db = openStore(stateDir);
  const row = db
    .prepare("SELECT * FROM turns WHERE id = ?")
    .get(turnId) as Record<string, unknown> | undefined;
  return row ? rowToTurn(row) : null;
}

/** All turn_recall rows for a turn (what was injected at that turn). */
export function listTurnRecall(
  turnId: number,
  stateDir: string = getStateDir(),
): TurnRecallRow[] {
  const db = openStore(stateDir);
  const rows = db
    .prepare(
      `SELECT id, turn_id, checkpoint_id, score, source, raptor_level
       FROM turn_recall WHERE turn_id = ? ORDER BY score DESC`,
    )
    .all(turnId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    turnId: r.turn_id as number,
    checkpointId: r.checkpoint_id as string,
    score: r.score as number,
    source: r.source as string,
    raptorLevel: (r.raptor_level as number | null) ?? null,
  }));
}

/** All turns in a conversation, ascending by turn_index. */
export function listConversationTurns(
  conversationId: string,
  stateDir: string = getStateDir(),
): TurnRow[] {
  const db = openStore(stateDir);
  const rows = db
    .prepare(
      `SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_index ASC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map(rowToTurn);
}

/** Resolve a session's conversation id, generating + persisting one if none.
 *  A resumed session inherits its existing conversationId from session_state. */
export function ensureConversationId(
  sessionId: string,
  stateDir: string = getStateDir(),
): string {
  const st = loadSessionState(sessionId, stateDir);
  if (st.conversationId) return st.conversationId;
  const conv = newConversationId();
  saveSessionState(sessionId, {
    ...st,
    conversationId: conv,
  }, stateDir);
  return conv;
}

/**
 * Fork a conversation at `forkTurnId`: create a new conversation id, record the
 * branch lineage, and return the parent's recall set at that turn (the
 * checkpoint_ids + scores that were injected) so the caller can seed the forked
 * session's injected-set with exactly that context.
 *
 * Returns the new conversation id + the recall-set rows to replay. The caller
 * (the engine/extension) is responsible for marking those checkpoint_ids as
 * injected in the new session's session_state so they're not re-recalled.
 */
export function forkConversation(
  parentConversationId: string,
  forkTurnId: number,
  stateDir: string = getStateDir(),
): { conversationId: string; recalled: TurnRecallRow[] } {
  const childId = newConversationId();
  const db: DatabaseSync = openStore(stateDir);
  withTx(db, () => {
    db.prepare(
      `INSERT INTO conversation_branches
         (conversation_id, parent_conversation_id, fork_turn_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO NOTHING`,
    ).run(childId, parentConversationId, forkTurnId, Date.now());
  });
  // Replay set: the parent's injected checkpoints at the fork turn.
  const recalled = listTurnRecall(forkTurnId, stateDir);
  return { conversationId: childId, recalled };
}

/** Clear turn tracking rows for a session (tests / DR). */
export function clearTurns(
  sessionId: string,
  stateDir: string = getStateDir(),
): void {
  const db: DatabaseSync = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  withTx(db, () => {
    const turnIds = db
      .prepare("SELECT id FROM turns WHERE session_id = ?")
      .all(sid) as Array<{ id: number }>;
    const ids = turnIds.map((t) => t.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM turn_recall WHERE turn_id IN (${placeholders})`).run(...ids);
    }
    db.prepare("DELETE FROM turns WHERE session_id = ?").run(sid);
  });
}
