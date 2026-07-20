/**
 * api-contracts/infrastructure.ts — Infrastructure, diagnostics, and monitoring contracts.
 *
 * Contains: InfraHealthResponse, InfraPerfSampleResponse,
 * InfraRateLimitStatus, InfraRateLimitResponse, ContextLevelState,
 * TierOverrideState, FallbackState, RepeatInjectionState,
 * SupersedeGatingState, MinHashBandState.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── /api/health ───────────────────────────────────────────────────────────

export interface InfraHealthResponse {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  version: string;
  db: 'ok' | 'error';
}

// ─── /api/perf ─────────────────────────────────────────────────────────────

export interface InfraPerfSampleResponse {
  updatedAt: string;
  samples: {
    compactP50: number;
    compactP95: number;
    tps: number;
    cacheHitPct: number;
    latencyP50: number;
    latencyP95: number;
    checks: {
      l0_exact: number;
      l1_minhash: number;
      l1_lsh: number;
      l2_dedup: number;
      raptor_tree: number;
    };
  } | null;
  counters: {
    compacts: { session: number; total: number };
    cacheHits: { session: number; total: number; sessionTokensSaved: number; totalTokensSaved: number };
    timeSaved: {
      compact: { sessionSec: number; totalSec: number };
      cacheHit: { sessionSec: number; totalSec: number };
    };
    storage: {
      dedupHits: number;
      dedupAttempts: number;
      compressedBytes: number;
      compressionPct: number;
    };
  };
  model: { name: string; provider: string; providerName: string; inputRate: number; outputRate: number } | null;
}

// ─── /api/rate-limit ───────────────────────────────────────────────────────

export interface InfraRateLimitStatus {
  requests: { windowMs: number; limit: number; remaining: number; resetAt: string };
  compact: { pending: number; active: number; queuedAt: string | null };
}

export interface InfraRateLimitResponse {
  status: InfraRateLimitStatus;
}

// ─── /api/context-level ────────────────────────────────────────────────────

export interface ContextLevelState {
  currentPct: number;
  thresholds: { watch: number; alert: number; critical: number };
  currentLevel: 'normal' | 'watch' | 'alert' | 'critical';
  config: { pressure: number; fastGatePct: number; tierMultiplier: number };
  activeTier: string;
  presetTier: string;
  tierHistory: Array<{ at: string; from: string; to: string; contextPct: number }>;
  contextWindow: number;
}

// ─── /api/tier-override ────────────────────────────────────────────────────

export interface TierOverrideState {
  currentTier: string;
  presetTier: string;
  isOverridden: boolean;
  override: { tier: string; reason: string; setAt: string } | null;
}

// ─── /api/fallback ────────────────────────────────────────────────────────

export interface FallbackState {
  currentAttempts: number;
  maxAttempts: number;
  degradeThreshold: number;
  fallbackMode: string | null;
  degraded: boolean;
  history: Array<{ at: string; from: string; to: string; trigger: string }>;
}

// ─── /api/repeat-injection ─────────────────────────────────────────────────

export interface RepeatInjectionState {
  protectedMessages: number[];
  seenHashes: string[];
  retentionWindow: number;
  stats: {
    totalInjected: number;
    repeatBlocked: number;
    repeatRatio: number;
    anchorPreserved: number;
    configPreserveRecent: number;
    effectiveRetention: number;
  };
  interaction: {
    preservedRecent: number;
    protectionFloor: number;
    fastGatePct: number;
    payloadSize: number;
    compactCount: number;
  };
  memory: {
    raptorPrototypes: number;
    semHashProto: number;
    embedDim: number;
    bandThreshold: number;
    topK: number;
    recentWindow: number;
  };
}

// ─── /api/supersede-gating ─────────────────────────────────────────────────

export interface SupersedeGatingState {
  gating: boolean;
  low: number;
  high: number;
  effectiveMin: number;
  config: { minTokens: number; totalOriginal: number; maxDepth: number };
  strategy: { tier: string; ageHours: number; queryShrink: number };
  stats: {
    superseded: number;
    notEligible: number;
    belowMinTokens: number;
    sumTokensPinned: number;
    sumBytesPinned: number;
    sumBytesDuplicate: number;
    sumBytesBeforeEligible: number;
    sumBytesAfterEligible: number;
  };
  history: Array<{ at: string; chunkId: string; reason: string }>;
}

// ─── /api/minhash-bands ───────────────────────────────────────────────────

export interface MinHashBandState {
  bandSize: number;
  numBands: number;
  matchingBands: number;
  candidatePairs: number;
  totalHashes: number;
  config: { threshold: number; numHashes: number; salt: string };
  stats: {
    estimatedDedup: number;
    falseNegativeRate: number;
    falsePositiveRate: number;
    cosDedup: number;
    exactDedup: number;
  };
  history: Array<{ at: string; hashId: string; band: number }>;
}
