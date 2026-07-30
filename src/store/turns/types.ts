/**
 * types.ts — S49 contract module (the source of truth).
 *
 * Every implementation must satisfy these interfaces. Hosts import only this
 * file + the factory from index.ts. SQL schemas are private to implementations.
 *
 * Design principles (from docs/specs/s49-rev1-architecture-upgrade.md):
 *   1. Contract-first — the interface IS the spec.
 *   2. Append-only — TurnWriter.append* are the only write methods; no UPDATE.
 *   3. Capability-gated — asReader/asWriter/asAdmin return subset views.
 *   4. Ledger protocol — host PUSHES facts, PULLS views. Store never initiates.
 *   5. StoreSnapshot — checkpoint/restore for backup, migration, test seeding.
 *
 * PREVENT-PI-004: zero network. PREVENT-002: no SQL here (private to impls).
 */

// ─── Domain types ───────────────────────────────────────────────────

/** Unique turn identifier (string to stay backend-agnostic). */
export type TurnId = string;

/** Unique conversation identifier. */
export type ConversationId = string;

/** Unique session identifier. */
export type SessionId = string;

/** A single turn record — an immutable, append-only fact. */
export interface TurnEntry {
	conversationId: ConversationId;
	sessionId: SessionId;
	turnIndex: number;
	role: "user" | "assistant" | "system" | "tool";
	endedAt: number; // epoch ms
	ctxTokens?: number; // context window tokens at end of turn
	ctxPercent?: number; // context window utilization 0-1
	pressureBand?: "green" | "yellow" | "red";
	model?: string; // model used for this turn
	/** S50B: the compact epoch that superseded this turn (stamped post-hoc). */
	epochId?: string;
}

/** A recall hit recorded during a turn — an immutable, append-only fact. */
export interface TurnRecallEntry {
	turnId: TurnId;
	checkpointId: string;
	score: number;
	source: "checkpoint" | "cluster_summary" | "memory";
	raptorLevel?: number;
}

/** A conversation fork — an immutable, append-only fact. */
export interface ConversationFork {
	parentConversationId: ConversationId;
	childConversationId: ConversationId;
	forkTurnIndex: number; // turn in the parent where the fork happened
	createdAt: number;
}

/** Filters for querying turns. All fields optional (AND-combined). */
export interface TurnFilter {
	conversationId?: ConversationId;
	sessionId?: SessionId;
	sinceMs?: number; // epoch ms lower bound
	untilMs?: number; // epoch ms upper bound
	pressureBand?: string;
	limit?: number;
	offset?: number;
}

/** What a prune operation removed. */
export interface PruneReport {
	turnsRemoved: number;
	recallRemoved: number;
	branchesPreserved: number;
	freedBytes: number; // approximate, from file-size delta
}

/** Retention policy — what the admin capability allows. */
export interface RetentionPolicy {
	maxTurnAgeMs: number; // delete turns older than this
	keepMinPerConversation: number; // always keep at least N turns per conversation
	vacuumAfterPrune: boolean; // run VACUUM after pruning
}

/** A complete snapshot for backup/migration/test-seeding. */
export interface StoreSnapshot {
	version: 1;
	exportedAt: number; // epoch ms
	turns: TurnEntry[];
	recall: TurnRecallEntry[];
	forks: ConversationFork[];
}

/** Aggregate stats for a conversation (materialized view, derived on read). */
export interface ConversationStats {
	turnCount: number;
	firstTurnAt: number;
	lastTurnAt: number;
	avgCtxPercent: number;
	pressureBands: Record<string, number>;
}

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * Thrown by `appendTurn` when a turn already exists at the given
 * `(conversationId, turnIndex)` coordinate. A turn index is a position in a
 * conversation, so the coordinate is unique by construction — a duplicate is a
 * programming error, not a data conflict.
 *
 * ISSUE #9: both backends MUST throw this (not a raw `ERR_SQLITE_ERROR`, and
 * not silently store a second row). Previously `SqliteTurnStore` threw an
 * uncaught `ERR_SQLITE_ERROR` (leaking the SQL abstraction) while
 * `InMemoryTurnStore` silently appended a duplicate — the contract diverged.
 * Callers (the extension's `recordTurnWrite`) already wrap `appendTurn` in
 * try/catch, so this is non-fatal to the agent loop; the typed error makes the
 * failure catchable and uniform across backends.
 */
export class DuplicateTurnError extends Error {
	readonly conversationId: string;
	readonly turnIndex: number;
	constructor(conversationId: string, turnIndex: number) {
		super(
			`Duplicate turn: a turn already exists at (conversationId=${conversationId}, turnIndex=${turnIndex})`,
		);
		this.name = "DuplicateTurnError";
		this.conversationId = conversationId;
		this.turnIndex = turnIndex;
	}
}

// ─── Capability interfaces ──────────────────────────────────────────

/** Read-only view — dashboards, TUI, analytics. Cannot write. */
export interface TurnReader {
	query(filter: TurnFilter): TurnEntry[];
	getTurn(turnId: TurnId): TurnEntry | undefined;
	/** Resolve a turn by its (conversationId, turnIndex) coordinate (fork + recall replay). */
	getTurnByIndex(
		conversationId: ConversationId,
		turnIndex: number,
	): TurnEntry | undefined;
	listRecall(turnId: TurnId): TurnRecallEntry[];
	/** Recall hits recorded for the turn at (conversationId, turnIndex) — the
	 *  replay set a fork rehydrates. Avoids needing the opaque TurnId. */
	listRecallByIndex(
		conversationId: ConversationId,
		turnIndex: number,
	): TurnRecallEntry[];
	listForks(conversationId: ConversationId): ConversationFork[];
	countTurns(conversationId: ConversationId): number;
	conversationStats(conversationId: ConversationId): ConversationStats;
}

/** Append-only writer — compaction engine, event handlers. Cannot prune. */
export interface TurnWriter {
	appendTurn(entry: TurnEntry): TurnId;
	appendRecall(entry: TurnRecallEntry): void;
	ensureConversationId(sessionId: SessionId): ConversationId;
	forkConversation(
		parentId: ConversationId,
		forkTurnIndex: number,
	): ConversationId;
}

/** Admin operations — prune command, DR, migration. */
export interface TurnAdmin {
	prune(policy: RetentionPolicy): PruneReport;
	vacuum(): void;
	checkpoint(): StoreSnapshot;
	restore(from: StoreSnapshot): void;
	clear(): void; // test-only; wipes all data
	/** S50B: stamp `epoch_id` on this session's turns that have none yet (links
	 *  a turn to the compact epoch that superseded it). Backfill UPDATE, so it
	 *  lives on the admin capability (the writer is append-only). Returns the
	 *  number of turns stamped. */
	stampTurnsEpoch(sessionId: SessionId, epochId: string): number;
}

/** The composed store — hosts get a capability-gated view. */
export interface TurnStore extends TurnReader, TurnWriter, TurnAdmin {
	/** Return a read-only view (for dashboards, TUI, analytics). */
	asReader(): TurnReader;
	/** Return an append-only view (for event handlers, compaction). */
	asWriter(): TurnWriter;
	/** Return an admin view (for prune, DR, migration). */
	asAdmin(): TurnAdmin;
	/** Close the underlying connection. For tests + graceful shutdown. */
	close(): void;
}

// ─── Factory ───────────────────────────────────────────────────────

/** Options for creating a TurnStore. */
export interface TurnStoreOptions {
	stateDir: string;
	/** Override DB path (for tests / DR). Default: join(stateDir, "turns.db") */
	dbPath?: string;
	/** In-memory mode (for tests). Default: false. */
	inMemory?: boolean;
}

/**
 * Factory: create a TurnStore from a state directory.
 *
 * By default returns a SqliteTurnStore backed by turns.db.
 * When options.inMemory is true, returns an InMemoryTurnStore.
 */
export type TurnStoreFactory = (options: TurnStoreOptions) => TurnStore;
