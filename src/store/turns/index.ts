/**
 * index.ts — S49 turn-store barrel. Re-export only; no logic.
 *
 * Hosts embed the platform via this single import surface:
 *   import { createTurnStore } from "pi-mega-compact/src/store/turns/index.js";
 */
export { createTurnStore, newConversationId } from "./turnStore.js";
export { openTurnStore, closeTurnStore, turnDbPath, TURNS_DB_FILE } from "./connection.js";
export { initTurnSchema } from "./schema.js";
export type {
  ConversationBranch,
  ForkResult,
  PendingFork,
  PruneOptions,
  RecallSource,
  RecordTurnInput,
  RecordTurnRecallHit,
  TurnRecallRow,
  TurnRow,
  TurnStore,
} from "./types.js";
