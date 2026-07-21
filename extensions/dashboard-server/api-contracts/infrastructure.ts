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

/**
 * Response body for `GET /api/health`.
 *
 * Reports the overall health, uptime, version, and database status of the
 * dashboard server.
 */
export interface InfraHealthResponse {
  /**
   * Overall health status.
   * Allowed values: `'ok'`, `'degraded'`, `'error'`.
   */
  status: 'ok' | 'degraded' | 'error';
  /** Server uptime since last restart (seconds). */
  uptime: number;
  /** Extension version string. */
  version: string;
  /**
   * Database health status.
   * Allowed values: `'ok'`, `'error'`.
   */
  db: 'ok' | 'error';
}

// ─── /api/perf ─────────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/perf`.
 *
 * Provides performance samples (percentiles, TPS, cache hit rate, latency),
 * aggregate counters, storage statistics, and active model information.
 */
export interface InfraPerfSampleResponse {
  /** ISO 8601 timestamp of the last performance sample update. */
  updatedAt: string;
  /** Performance percentile samples, or `null` when no samples are available. */
  samples: {
    /** p50 compaction duration (milliseconds). */
    compactP50: number;
    /** p95 compaction duration (milliseconds). */
    compactP95: number;
    /** Tokens per second processing rate (tokens per second). */
    tps: number;
    /** Cache hit rate (percent, 0–100). */
    cacheHitPct: number;
    /** p50 request latency (milliseconds). */
    latencyP50: number;
    /** p95 request latency (milliseconds). */
    latencyP95: number;
    /** Per-tier dedup check counts. */
    checks: {
      /** L0 exact-hash dedup check count. */
      l0_exact: number;
      /** L1 MinHash dedup check count. */
      l1_minhash: number;
      /** L1 LSH dedup check count. */
      l1_lsh: number;
      /** L2 semantic dedup check count. */
      l2_dedup: number;
      /** RAPTOR tree dedup check count. */
      raptor_tree: number;
    };
  } | null;
  /** Aggregate operational counters. */
  counters: {
    /** Compaction run counts. */
    compacts: {
      /** Compactions performed this session. */
      session: number;
      /** Total compactions performed. */
      total: number;
    };
    /** Cache hit statistics. */
    cacheHits: {
      /** Cache hits in the current session. */
      session: number;
      /** Total cache hits across all sessions. */
      total: number;
      /** Tokens saved by cache hits this session (tokens). */
      sessionTokensSaved: number;
      /** Total tokens saved by cache hits (tokens). */
      totalTokensSaved: number;
    };
    /** Time saved by compaction and cache hits. */
    timeSaved: {
      /** Time saved by compaction. */
      compact: {
        /** Seconds saved by compaction this session (seconds). */
        sessionSec: number;
        /** Total seconds saved by compaction (seconds). */
        totalSec: number;
      };
      /** Time saved by cache hits. */
      cacheHit: {
        /** Seconds saved by cache hits this session (seconds). */
        sessionSec: number;
        /** Total seconds saved by cache hits (seconds). */
        totalSec: number;
      };
    };
    /** Storage-level dedup statistics. */
    storage: {
      /** Number of dedup hits at the storage level. */
      dedupHits: number;
      /** Number of dedup attempts at the storage level. */
      dedupAttempts: number;
      /** Compressed byte size (bytes). */
      compressedBytes: number;
      /** Compression ratio at the storage level (percent, 0–100). */
      compressionPct: number;
    };
  };
  /** Active model information, or `null` when no model is configured. */
  model: {
    /** Model name/identifier. */
    name: string;
    /** Machine-readable provider identifier. */
    provider: string;
    /** Human-readable provider name. */
    providerName: string;
    /** Model input processing rate (tokens per second). */
    inputRate: number;
    /** Model output processing rate (tokens per second). */
    outputRate: number;
  } | null;
}

// ─── /api/rate-limit ───────────────────────────────────────────────────────

/**
 * Rate-limit status for the dashboard API.
 *
 * Used as the `status` field in `InfraRateLimitResponse`.
 */
export interface InfraRateLimitStatus {
  /** Request rate-limit window configuration. */
  requests: {
    /** Duration of the rate-limit window (milliseconds). */
    windowMs: number;
    /** Maximum requests allowed within the window. */
    limit: number;
    /** Remaining requests in the current window. */
    remaining: number;
    /** ISO 8601 timestamp when the window resets. */
    resetAt: string;
  };
  /** Compaction rate-limit status. */
  compact: {
    /** Number of pending compaction requests. */
    pending: number;
    /** Number of actively running compactions. */
    active: number;
    /** ISO 8601 timestamp of the earliest queued compaction, or `null` when no compactions are queued. */
    queuedAt: string | null;
  };
}

/**
 * Response body for `GET /api/rate-limit`.
 *
 * Wraps the rate-limit status object.
 */
export interface InfraRateLimitResponse {
  /** Current rate-limit status. */
  status: InfraRateLimitStatus;
}

// ─── /api/context-level ────────────────────────────────────────────────────

/**
 * Response body for `GET /api/context-level`.
 *
 * Reports the current context pressure level, configured thresholds, tier
 * information, and tier transition history.
 */
export interface ContextLevelState {
  /** Current context pressure (percent, 0–100). */
  currentPct: number;
  /** Pressure thresholds for each level. */
  thresholds: {
    /** Pressure at which the `'watch'` level activates (percent, 0–100). */
    watch: number;
    /** Pressure at which the `'alert'` level activates (percent, 0–100). */
    alert: number;
    /** Pressure at which the `'critical'` level activates (percent, 0–100). */
    critical: number;
  };
  /**
   * Current context level based on pressure vs thresholds.
   * Allowed values: `'normal'`, `'watch'`, `'alert'`, `'critical'`.
   */
  currentLevel: 'normal' | 'watch' | 'alert' | 'critical';
  /** Configuration affecting context pressure and tier selection. */
  config: {
    /** Pressure baseline (percent, 0–100). */
    pressure: number;
    /** Fast-gate pressure threshold (percent, 0–100). */
    fastGatePct: number;
    /** Tier multiplier applied to thresholds. */
    tierMultiplier: number;
  };
  /** Currently active compaction tier name. */
  activeTier: string;
  /** Preset (default) compaction tier name. */
  presetTier: string;
  /** History of recent tier transitions. */
  tierHistory: Array<{
    /** ISO 8601 timestamp of the transition. */
    at: string;
    /** Previous tier name. */
    from: string;
    /** New tier name. */
    to: string;
    /** Context pressure at the time of transition (percent, 0–100). */
    contextPct: number;
  }>;
  /** Maximum context window size for the active model (tokens). */
  contextWindow: number;
}

// ─── /api/tier-override ────────────────────────────────────────────────────

/**
 * Response body for `GET /api/tier-override`.
 *
 * Reports whether the compaction tier is currently overridden and, if so,
 * the override details.
 */
export interface TierOverrideState {
  /** Currently active compaction tier name (may be overridden). */
  currentTier: string;
  /** Preset (default) compaction tier name. */
  presetTier: string;
  /** Whether the tier is currently overridden. */
  isOverridden: boolean;
  /** Override details. Present when `isOverridden` is `true`; `null` when no override is active. */
  override: {
    /** Compaction tier name set by the override. */
    tier: string;
    /** Human-readable reason for the override. */
    reason: string;
    /** ISO 8601 timestamp when the override was set. */
    setAt: string;
  } | null;
}

// ─── /api/fallback ────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/fallback`.
 *
 * Reports the model fallback state, including degradation status, attempt
 * counts, and fallback transition history.
 */
export interface FallbackState {
  /** Current number of fallback attempts. */
  currentAttempts: number;
  /** Maximum fallback attempts before entering degraded mode. */
  maxAttempts: number;
  /** Threshold at which degradation kicks in. */
  degradeThreshold: number;
  /** Current fallback mode name, or `null` when no fallback is active. */
  fallbackMode: string | null;
  /** Whether the system is currently in degraded mode. */
  degraded: boolean;
  /** History of fallback transitions. */
  history: Array<{
    /** ISO 8601 timestamp of the transition. */
    at: string;
    /** Previous mode name. */
    from: string;
    /** New mode name. */
    to: string;
    /** Trigger that caused the transition. */
    trigger: string;
  }>;
}

// ─── /api/repeat-injection ─────────────────────────────────────────────────

/**
 * Response body for `GET /api/repeat-injection`.
 *
 * Reports the state of repeat-injection protection, including protected
 * messages, seen hashes, retention configuration, and memory/index statistics.
 */
export interface RepeatInjectionState {
  /** Indices of messages currently protected from re-injection. */
  protectedMessages: number[];
  /** Content hashes already seen by the repeat-injection guard. */
  seenHashes: string[];
  /** Number of recent messages in the retention window. */
  retentionWindow: number;
  /** Repeat-injection statistics. */
  stats: {
    /** Total number of chunks injected. */
    totalInjected: number;
    /** Number of repeat injections blocked. */
    repeatBlocked: number;
    /** Ratio of repeats blocked to total injections (0–1). */
    repeatRatio: number;
    /** Number of anchor messages preserved. */
    anchorPreserved: number;
    /** Configured `preserveRecent` value (number of messages). */
    configPreserveRecent: number;
    /** Effective retention window after configuration adjustments. */
    effectiveRetention: number;
  };
  /** Interaction-level protection state. */
  interaction: {
    /** Number of recent messages actually preserved in the last interaction. */
    preservedRecent: number;
    /** Protection floor — minimum messages always preserved. */
    protectionFloor: number;
    /** Fast-gate pressure threshold (percent, 0–100). */
    fastGatePct: number;
    /** Size of the current context payload (bytes). */
    payloadSize: number;
    /** Number of compactions performed. */
    compactCount: number;
  };
  /** Memory and index configuration. */
  memory: {
    /** Number of RAPTOR prototypes stored. */
    raptorPrototypes: number;
    /** Number of semantic hash prototypes. */
    semHashProto: number;
    /** Embedding vector dimensionality (dimensions). */
    embedDim: number;
    /** Band similarity threshold for MinHash LSH (0–1). */
    bandThreshold: number;
    /** Top-K recall limit. */
    topK: number;
    /** Number of recent messages in the memory window. */
    recentWindow: number;
  };
}

// ─── /api/supersede-gating ─────────────────────────────────────────────────

/**
 * Response body for `GET /api/supersede-gating`.
 *
 * Reports the state of the supersede gating mechanism, including thresholds,
 * strategy, statistics, and history.
 */
export interface SupersedeGatingState {
  /** Whether supersede gating is currently active. */
  gating: boolean;
  /** Low token threshold below which supersede is disabled (tokens). */
  low: number;
  /** High token threshold above which supersede is enabled (tokens). */
  high: number;
  /** Effective minimum token count for supersede eligibility (tokens). */
  effectiveMin: number;
  /** Supersede configuration. */
  config: {
    /** Configured minimum token threshold (tokens). */
    minTokens: number;
    /** Total original tokens in the eligible set (tokens). */
    totalOriginal: number;
    /** Maximum supersede nesting depth. */
    maxDepth: number;
  };
  /** Current supersede strategy. */
  strategy: {
    /** Compaction tier applied by the strategy. */
    tier: string;
    /** Age threshold for eligibility (hours). */
    ageHours: number;
    /** Query shrink factor applied by the strategy (percent, 0–100). */
    queryShrink: number;
  };
  /** Supersede statistics. */
  stats: {
    /** Number of chunks superseded. */
    superseded: number;
    /** Number of chunks not eligible for supersede. */
    notEligible: number;
    /** Number of chunks below the minimum token threshold (tokens). */
    belowMinTokens: number;
    /** Sum of tokens pinned (not superseded) (tokens). */
    sumTokensPinned: number;
    /** Sum of bytes pinned (not superseded) (bytes). */
    sumBytesPinned: number;
    /** Sum of bytes in duplicate chunks (bytes). */
    sumBytesDuplicate: number;
    /** Sum of bytes before eligibility filtering (bytes). */
    sumBytesBeforeEligible: number;
    /** Sum of bytes after eligibility filtering (bytes). */
    sumBytesAfterEligible: number;
  };
  /** History of supersede gating events. */
  history: Array<{
    /** ISO 8601 timestamp of the event. */
    at: string;
    /** Chunk identifier involved. */
    chunkId: string;
    /** Reason for the gating decision. */
    reason: string;
  }>;
}

// ─── /api/minhash-bands ───────────────────────────────────────────────────

/**
 * Response body for `GET /api/minhash-bands`.
 *
 * Reports the state of the MinHash LSH banding configuration, including band
 * parameters, matching statistics, and estimated dedup rates.
 */
export interface MinHashBandState {
  /** Number of hashes per band. */
  bandSize: number;
  /** Total number of bands in the LSH index. */
  numBands: number;
  /** Number of bands with matching hash pairs. */
  matchingBands: number;
  /** Number of candidate pairs generated by band matching. */
  candidatePairs: number;
  /** Total number of hashes stored. */
  totalHashes: number;
  /** MinHash LSH configuration. */
  config: {
    /** Similarity threshold for candidate selection (0–1). */
    threshold: number;
    /** Total number of hash functions used. */
    numHashes: number;
    /** Salt value used for hash randomization. */
    salt: string;
  };
  /** Dedup estimation and accuracy statistics. */
  stats: {
    /** Estimated number of duplicates detected (count). */
    estimatedDedup: number;
    /** Estimated false negative rate (0–1). */
    falseNegativeRate: number;
    /** Estimated false positive rate (0–1). */
    falsePositiveRate: number;
    /** Number of cosine-similarity dedup hits. */
    cosDedup: number;
    /** Number of exact-hash dedup hits. */
    exactDedup: number;
  };
  /** History of MinHash band events. */
  history: Array<{
    /** ISO 8601 timestamp of the event. */
    at: string;
    /** Hash identifier involved. */
    hashId: string;
    /** Band number that matched. */
    band: number;
  }>;
}
