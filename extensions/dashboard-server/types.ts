/**
 * dashboard-server/types.ts — shared types for the dashboard server.
 */

// Active-window cutoff (seconds) for the /api/servers endpoint.
export const ACTIVE_WINDOW_SEC = 1800;

export interface IndexRepo {
  repoRoot: string;
  displayName: string;
  stateDir: string;
  checkpointCount: number;
  tokensSaved: number;
  compressedOriginalBytes: number;
  lastCompactedAt: number | null;
  provider: string | null;
  providerName: string | null;
  modelName: string | null;
  inputRate: number | null;
  outputRate: number | null;
  lastSeen: number;
  // Per-repo token + model detail (S25 dashboard enrichment), read directly
  // from each repo's node:sqlite store at stateDir. tokensKept = Σ stored
  // summary tokens ("out"); tokensDropped = Σ original region tokens ("in");
  // sessions = distinct sessions with a checkpoint; contextWindow/maxTokens/
  // reasoning come from the latest model_snapshots row for that repo.
  tokensKept: number;
  tokensDropped: number;
  sessions: number;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
}

export interface IndexSummary {
  totalRepos: number;
  totalCheckpoints: number;
  totalTokensSaved: number;
  totalCompressedOriginalBytes: number;
}

export type IndexIndex = { updatedAt: string; summary: IndexSummary | null; repos: IndexRepo[] };

export interface Snapshot {
  version: number;
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

export interface LiveSnapshot { tier?: string; updatedAt?: string | null; context?: { tokens?: number | null; percent?: number | null; contextWindow?: number }; session?: { id?: string; state?: string }; cacheHits?: { session: number; total: number; sessionTokensSaved: number; totalTokensSaved: number }; compacts?: { session: number; total: number }; timeSaved?: { compact: { sessionSec: number; totalSec: number }; cacheHit: { sessionSec: number; totalSec: number } }; }
