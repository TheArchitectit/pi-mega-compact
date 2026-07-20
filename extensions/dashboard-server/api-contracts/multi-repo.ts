/**
 * api-contracts/multi-repo.ts — Multi-repo index and repo management contracts.
 *
 * Contains: RepoListItem, RepoSnapshotEntry, RepoSnapshotMap,
 * IndexesIndexRow, IndexesSummaryResponse, IndexesDiffEntry,
 * DiffRequest, DiffResponse, UpdateRepoConfigRequest.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/repos ────────────────────────────────────────────────────────────

export interface RepoListItem {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
  tokenTotal: number;
  lastSeen: number;
}

// ─── /api/repo-snapshot ────────────────────────────────────────────────────

export interface RepoSnapshotEntry {
  updatedAt: string | null;
  tier: string;
  presetTier: string;
  pressure: number;
  session: { id: string | null; state: string | null };
  context: { tokens: number | null; percent: number | null; contextWindow: number };
  store: { checkpointCount: number; tokensSaved: number; dedupCollapsed: number; storageDedupRate: number };
  compression: {
    session: { tokensIn: number; tokensOut: number; tokensFreed: number; compressionPct: number; dedupPct: number };
    repo: { tokensIn: number; tokensOut: number; tokensFreed: number; compressionPct: number; dedupPct: number };
  };
  model?: { name: string; provider: string; providerName: string; inputRate: number; outputRate: number };
}

export type RepoSnapshotMap = Record<string, RepoSnapshotEntry | null>;

// ─── /api/indexes ──────────────────────────────────────────────────────────

export interface IndexesIndexRow {
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
  tokensKept: number;
  tokensDropped: number;
  sessions: number;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
}

export interface IndexesSummaryResponse {
  updatedAt: string;
  totalRepos: number;
  totalCheckpoints: number;
  totalTokensSaved: number;
  totalCompressedOriginalBytes: number;
  repos: IndexesIndexRow[];
}

// ─── /api/indexes/diff ─────────────────────────────────────────────────────

export interface IndexesDiffEntry {
  id: string;
  type: 'add' | 'remove' | 'change';
  repo?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  severity: 'info' | 'warn' | 'critical';
}

export interface DiffRequest {
  side: 'client' | 'server';
  snapshot?: SnapshotLike;
}

/** Minimal shape for snapshot comparison (avoids coupling to full SnapshotResponse). */
export interface SnapshotLike {
  updatedAt?: string | null;
  store?: { checkpointCount?: number; tokensSaved?: number };
  compression?: {
    repo?: { tokensIn?: number; tokensOut?: number; compressionPct?: number; dedupPct?: number };
    session?: { tokensIn?: number; tokensOut?: number };
  };
  session?: { id?: string | null; state?: string | null };
  model?: { name?: string; provider?: string };
  trigger?: { armed?: boolean; ready?: boolean };
}

export interface DiffResponse {
  diffs: IndexesDiffEntry[];
  serverSnapshot: SnapshotLike;
}

// ─── PUT /api/repo-config ─────────────────────────────────────────────────

export interface UpdateRepoConfigRequest {
  repoId: string;
  displayName?: string;
}
