/**
 * index.ts — Barrel for src/store/turns/ (S49 reconciled).
 *
 * Re-exports the contract-first factory + all contract types (master's design)
 * and the two backend constructors (SqliteTurnStore / InMemoryTurnStore), plus
 * this branch's reconciled connection layer + migration helper. Hosts import
 * only this file + types.ts.
 *
 * PREVENT-PI-004: no network. Reuse-clean: no pi imports.
 */

export type {
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
	TurnReader,
	TurnWriter,
	TurnAdmin,
	TurnStore,
	TurnStoreOptions,
	TurnStoreFactory,
} from "./types.js";

export { SqliteTurnStore } from "./sqlite-store.js";
export { InMemoryTurnStore } from "./memory-store.js";
// ISSUE #9: the typed error both backends throw on a duplicate (conversationId,
// turnIndex) append. Re-exported so callers can `instanceof DuplicateTurnError`.
export { DuplicateTurnError } from "./types.js";

// Reconciled connection layer (master shape + this branch's migration +
// closed-handle eviction + env override + openTurnStore back-compat alias).
export {
	openTurnDb,
	openTurnStore,
	closeTurnDb,
	closeTurnStore,
	closeAllTurnDbs,
	turnDbPath,
	TURNS_DB_FILE,
	withTx,
} from "./connection.js";
export { initTurnSchema } from "./schema.js";
export { migrateTurnTablesIfNeeded } from "./migrations.js";

import { SqliteTurnStore } from "./sqlite-store.js";
import { InMemoryTurnStore } from "./memory-store.js";
import type { TurnStore, TurnStoreOptions } from "./types.js";

/**
 * Factory: create a TurnStore from options.
 *
 * - Default: SqliteTurnStore backed by turns.db in stateDir
 * - inMemory: InMemoryTurnStore (no file I/O)
 */
export function createTurnStore(options: TurnStoreOptions): TurnStore {
	if (options.inMemory) {
		return new InMemoryTurnStore(options);
	}
	return new SqliteTurnStore(options);
}
