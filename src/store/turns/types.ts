/**
 * types.ts — S49 turn-store types + the host-agnostic TurnStore interface.
 *
 * Ported unchanged from src/store/sqlite/turns.ts (S48) and extended with the
 * reuse-facing TurnStore interface. This module is pi-agnostic: it imports no
 * ExtensionAPI / MegaRuntime / @earendil-works types so any host (own TUI, API
 * gateway) can embed src/store/turns/ directly. See
 * docs/specs/s49-turn-db-foundation.md (REUSE CONTRACT).
 */

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

/** A row in `conversation_branches` (fork lineage). */
export interface ConversationBranch {
  conversationId: string;
  parentConversationId: string;
  forkTurnId: number;
  createdAt: number;
}

/**
 * A row in `pending_fork` — a rewind-and-fork intent written by an external
 * surface (the dashboard) and consumed by the host at a safe lifecycle point.
 * Schema lands in S49; the writer + consumer land in S52.
 */
export interface PendingFork {
  id: number;
  targetConversationId: string;
  targetTurnId: number;
  requestedAt: number;
  consumedAt: number | null;
}

/** Input to recordTurn (conversationId/sessionId/turnIndex required). */
export interface RecordTurnInput {
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
}

/** One recalled hit to persist against a turn. */
export interface RecordTurnRecallHit {
  checkpointId: string;
  score: number;
  source: RecallSource;
  raptorLevel?: number;
}

/** Result of forkConversation: the new child conversation + the recall set to replay. */
export interface ForkResult {
  conversationId: string;
  recalled: TurnRecallRow[];
}

/** Options for pruneTurns. */
export interface PruneOptions {
  /** Delete turns older than now - olderThanMs. */
  olderThanMs: number;
  /** Always keep at least this many most-recent turns per conversation. */
  keepMinPerConversation: number;
  /** now override (tests). Defaults to Date.now(). */
  now?: number;
}

/**
 * The host-agnostic turn store. Every method is synchronous (node:sqlite) and
 * best-effort-safe at the call site — the store throws on real errors; the
 * host wraps calls in try/catch to keep the agent loop non-fatal.
 */
export interface TurnStore {
  recordTurn(input: RecordTurnInput): number;
  recordTurnRecall(turnId: number, hits: RecordTurnRecallHit[]): void;
  getTurn(conversationId: string, turnIndex: number): TurnRow | null;
  getTurnById(turnId: number): TurnRow | null;
  listTurnRecall(turnId: number): TurnRecallRow[];
  listConversationTurns(conversationId: string): TurnRow[];
  ensureConversationId(sessionId: string): string;
  forkConversation(parentConversationId: string, forkTurnId: number): ForkResult;
  clearTurns(sessionId: string): void;
  pruneTurns(opts: PruneOptions): { deletedTurns: number; deletedRecall: number };
  vacuum(): void;
  close(): void;
}
