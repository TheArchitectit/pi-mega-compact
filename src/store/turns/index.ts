/**
 * index.ts — Barrel for src/store/turns/.
 *
 * Re-exports the factory, all types, and the two backend constructors.
 * Hosts import only this file + types.ts.
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
