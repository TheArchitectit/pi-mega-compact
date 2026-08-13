/**
 * bridge/types.ts — contract types for the bidirectional mega-compact bridge.
 *
 * A pi-agnostic, unit-testable adapter surface that wraps the engine's
 * compaction / recall / memory / fork / vector APIs behind one factory so an
 * external host (ithacus) can drive them without importing pi-runtime types.
 * Every type here mirrors a real engine signature (see factory.ts for the
 * wiring).
 */

import type { EngineMessage } from "../types.js";

/** Same shape as the engine's internal message. Identity re-export. */
export type BridgeMessage = EngineMessage;

/** Bridge construction options. */
export interface BridgeOptions {
  stateDir: string;
}

/** Input to compact a message slice into a checkpoint. */
export interface BridgeCompactInput {
  sessionId: string;
  messages: BridgeMessage[];
  keepFrom?: number;
  summary?: string;
  keyDecisions?: string[];
  nextSteps?: string[];
  filesModified?: string[];
  compressionPressure?: number;
}

/** Useful subset of CompactResult. */
export interface BridgeCompactResult {
  skipped: boolean;
  deduped: boolean;
  summary: string;
  checkpointId?: string;
  tokenEstimate: number;
  originalTokenEstimate?: number;
  compactedFrom?: number;
}

/** Options for checkpoint recall (per-session). */
export interface BridgeRecallOptions {
  sessionId: string;
  query: string;
  limit?: number;
  recallMaxTokens?: number;
  skipInjected?: boolean;
}

/** Mapped from RecallInjectResult. */
export interface BridgeRecallResult {
  block: string;
  report: string[];
  hitCount: number;
  empty: boolean;
}

/** Options for durable memory recall (stateDir-scoped, no sessionId). */
export interface BridgeMemoryRecallOptions {
  query: string;
  limit?: number;
  minSimilarity?: number;
  crossRepo?: boolean;
  crossRepoCosine?: number;
  recallMaxTokens?: number;
}

export interface BridgeMemoryRecallResult {
  block: string;
  report: string[];
  hitCount: number;
  empty: boolean;
}

/** Options to fork a child conversation off a parent turn. */
export interface BridgeForkOptions {
  parentConversationId: string;
  turnIndex: number;
}

/** Fork result: success variant OR a graceful error variant. */
export interface BridgeForkSuccess {
  childConversationId: string;
  checkpointIds: string[];
  forkTurnIndex: number;
}
export interface BridgeForkError {
  error: "TURN_NOT_FOUND" | "NO_RECALL";
}
export type BridgeForkResult = BridgeForkSuccess | BridgeForkError;

/** Options for a top-k corpus / vector query. */
export interface BridgeCortexOptions {
  query: string;
  limit?: number;
  repo?: string;
}

export interface BridgeCortexResult {
  results: Array<{ checkpointId: string; score: number; summary?: string }>;
  hitCount: number;
}

/** Input to persist a durable memory. */
export interface BridgeAddMemoryInput {
  content: string;
  kind?: string;
  tags?: string[];
  category?: string;
}

/** Input to record a turn fact. */
export interface BridgeRecordTurnInput {
  conversationId: string;
  sessionId: string;
  turnIndex: number;
  role?: string;
  endedAt?: number;
  ctxTokens?: number;
  ctxPercent?: number;
  model?: string;
}

/** The bridge surface exposed to the host. */
export interface MegaBridge {
  compact(input: BridgeCompactInput): BridgeCompactResult;
  recallCheckpoints(opts: BridgeRecallOptions): BridgeRecallResult;
  recallMemories(opts: BridgeMemoryRecallOptions): Promise<BridgeMemoryRecallResult>;
  recallAndInlineAsync(opts: BridgeRecallOptions): Promise<BridgeRecallResult>;
  fork(opts: BridgeForkOptions): BridgeForkResult;
  cortexQuery(opts: BridgeCortexOptions): BridgeCortexResult;
  addMemory(input: BridgeAddMemoryInput): number | void;
  recordTurn(input: BridgeRecordTurnInput): void;
  close(): void;
}
