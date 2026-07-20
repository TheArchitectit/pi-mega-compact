/**
 * api-contracts/snapshot.ts — Snapshot / store / compression / session contracts.
 *
 * Contains: SnapshotResponse, TriggerResponse, CompressionTotalsResponse,
 * CompactHistoryEntry, CompactionRequest, CompactionResponse.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/snapshot ─────────────────────────────────────────────────────────

export interface SnapshotResponse {
  updatedAt: string | null;
  tier: string;
  presetTier: string;
  pressure: number;
  config: {
    fastGatePct: number;
    thresholdTokens: number;
    anchorUserMessages: number;
    preserveRecent: number;
    auto: boolean;
    autoInlineK: number;
  };
  session: {
    id: string | null;
    state: string | null;
    persistedThisSession: boolean;
    lastCheckpointId: string | null;
    lastCompactedFrom: number;
  };
  context: {
    tokens: number | null;
    percent: number | null;
    contextWindow: number;
  };
  trigger: {
    armed: boolean;
    ready: boolean;
    currentTokens: number | null;
    thresholdTokens: number;
    fastGatePct: number;
  };
  store: {
    checkpointCount: number;
    totalTokenEstimate: number;
    originalTokens: number;
    tokensSaved: number;
    injectedCount: number;
    dedupHitRate: number;
    storageDedupRate: number;
    dedupCollapsed: number;
  };
  crew: {
    activeAgents: number;
    currentTurn: number;
  };
  repo: {
    checkpointCount: number;
    totalTokenEstimate: number;
    originalTokens: number;
    tokensSaved: number;
    sessionCount: number;
    dedupAttempts: number;
    dedupCollapsed: number;
    storageDedupRate: number;
  };
  integrity: {
    regionsRetained: number;
    compressedOriginalBytes: number;
    duplicatesCollapsed: number;
    bytesPermanentlyDeleted: number;
  };
  cacheHits: {
    session: number;
    total: number;
    sessionTokensSaved: number;
    totalTokensSaved: number;
  };
  compacts: {
    session: number;
    total: number;
  };
  timeSaved: {
    compact: { sessionSec: number; totalSec: number };
    cacheHit: { sessionSec: number; totalSec: number };
  };
  compression: {
    session: { tokensIn: number; tokensOut: number; tokensFreed: number; compressionPct: number; dedupPct: number };
    repo: { tokensIn: number; tokensOut: number; tokensFreed: number; compressionPct: number; dedupPct: number };
  };
  model?: {
    name: string;
    provider: string;
    providerName: string;
    inputRate: number;
    outputRate: number;
  };
}

// ─── /api/trigger ──────────────────────────────────────────────────────────

export interface TriggerResponse {
  armed: boolean;
  ready: boolean;
  currentTokens: number | null;
  thresholdTokens: number;
  fastGatePct: number;
}

// ─── /api/compression-totals ───────────────────────────────────────────────

export interface CompressionTotalsResponse {
  repo: { tokensIn: number; tokensOut: number; tokensFreed: number; compressionPct: number; dedupPct: number };
  session: { tokensIn: number; tokensOut: number; tokensFreed: number; compressionPct: number; dedupPct: number };
  compacts: { session: number; total: number };
  cacheHits: { session: number; total: number; sessionTokensSaved: number; totalTokensSaved: number };
  timeSaved: {
    compact: { sessionSec: number; totalSec: number };
    cacheHit: { sessionSec: number; totalSec: number };
  };
}

// ─── /api/compact-history ─────────────────────────────────────────────────

export interface CompactHistoryEntry {
  id: string;
  ts: string;
  tier: string;
  trigger: 'manual' | 'auto' | 'fast-gate' | 'ctx-pressure';
  checkpointBefore: number;
  checkpointAfter: number;
  contextBefore: number;
  contextAfter: number;
  tokensIn: number;
  tokensOut: number;
  tokensFreed: number;
  dedupCollapsed?: number;
}

// ─── POST /api/compact ─────────────────────────────────────────────────────

export interface CompactionRequest {
  target?: 'aggressive' | 'standard' | 'fast-gate';
  reason?: string;
}

export interface CompactionResponse {
  status: 'ok' | 'error' | 'skipped';
  beforeTokens?: number;
  afterTokens?: number;
  tokensFreed?: number;
  tier?: string;
  checkpointId?: string;
  durationMs?: number;
  message?: string;
}
