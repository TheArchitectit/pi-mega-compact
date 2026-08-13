/**
 * ctx.ts — internal context interface for InMemoryTurnStore method bodies
 * (extracted from memory-store.ts). Each free function in this directory
 * operates on a MemoryTurnStoreCtx so the shell class can delegate without
 * exposing its private fields.
 *
 * Mirrors sqlite-store/ctx.ts. The Map/array references are stable for the
 * life of the store: arrays (recall, forks) are mutated IN PLACE
 * (push/splice/length=0), never reassigned, so a ctx captured at any point
 * sees the current contents. The id counter is module-scoped here so both the
 * shell (writers) and admin.ts share one allocator.
 */
import { randomBytes } from "node:crypto";
import type {
	ConversationFork,
	ConversationId,
	SessionId,
	TurnEntry,
	TurnRecallEntry,
} from "../types.js";

/** Internal row with numeric id. */
export interface TurnRow {
	id: number;
	entry: TurnEntry;
	epochId?: string;
}

/** Internal recall row keyed by numeric turn id. */
export interface RecallRow {
	turnId: number;
	entry: TurnRecallEntry;
}

/** The mutable in-memory state free functions operate on. */
export interface MemoryTurnStoreCtx {
	turns: Map<number, TurnRow>;
	recall: RecallRow[];
	forks: ConversationFork[];
	convIndex: Map<ConversationId, number[]>;
	sessionConv: Map<SessionId, ConversationId>;
}

// Auto-increment counter — shared by writers (appendTurn/forkConversation) and
// admin (restore). Module-scoped so a single counter spans the store's life.
let nextId = 1;

export function allocId(): number {
	return nextId++;
}

export function resetIdCounter(): void {
	nextId = 1;
}

export function newConversationId(): ConversationId {
	return `conv_${randomBytes(8).toString("hex")}`;
}

export function normalizeSessionId(sid: SessionId): SessionId {
	return sid.replace(/-.*$/, "");
}
