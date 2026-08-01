/**
 * cache.ts — in-memory LRU cache with TTL for query reformulation results (S43A-8).
 *
 * Kept in a separate file to keep queryReformulation.ts under file limits.
 * Also holds the env-constant defaults and the uncalibrated-constant bookkeeping.
 */

// ---------------------------------------------------------------------------
// Env-Overridable Defaults (sourced from the main file's constants)
// ---------------------------------------------------------------------------

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const RRF_K = envNum("MEGACOMPACT_RRF_K", 60);
export const EXPANSION_NEIGHBOR_COUNT = envNum("MEGACOMPACT_EXPANSION_NEIGHBOR_COUNT", 5);
export const EXPANSION_TOP_TERMS = envNum("MEGACOMPACT_EXPANSION_TOP_TERMS", 5);
export const VAGUE_MIN_WORDS = envNum("MEGACOMPACT_VAGUE_MIN_WORDS", 3);
export const VAGUE_VERY_SHORT_WORDS = envNum("MEGACOMPACT_VAGUE_VERY_SHORT_WORDS", 2);
export const QUERY_REFORM_CACHE_TTL_SECONDS = envNum("MEGACOMPACT_QUERY_REFORM_CACHE_TTL_SECONDS", 300);
export const CACHE_MAX_SIZE = envNum("MEGACOMPACT_QUERY_REFORM_CACHE_SIZE", 100);
const CACHE_STATS_INTERVAL = envNum("MEGACOMPACT_CACHE_STATS_INTERVAL", 100);

/** Which constant names are uncalibrated (not backed by a paper/benchmark). */
const UNCALIBRATED_NAMES: ReadonlySet<string> = new Set([
  "EXPANSION_NEIGHBOR_COUNT",
  "EXPANSION_TOP_TERMS",
  "VAGUE_MIN_WORDS",
  "VAGUE_VERY_SHORT_WORDS",
  "QUERY_REFORM_CACHE_TTL_SECONDS",
]);

// ---------------------------------------------------------------------------
// Which calibrated defaults are at their fallback (uncalibrated set)
// ---------------------------------------------------------------------------

export interface ReformulationConfig {
  neighborCount: number;
  topTerms: number;
  vagueMinWords: number;
  vagueVeryShortWords: number;
  cacheTtlSeconds: number;
  rrfK: number;
  searchLimit: number;
}

export function computeUncalibrated(opts: ReformulationConfig): string[] {
  const out: string[] = [];

  if (opts.neighborCount === EXPANSION_NEIGHBOR_COUNT && UNCALIBRATED_NAMES.has("EXPANSION_NEIGHBOR_COUNT")) {
    out.push("EXPANSION_NEIGHBOR_COUNT");
  }
  if (opts.topTerms === EXPANSION_TOP_TERMS && UNCALIBRATED_NAMES.has("EXPANSION_TOP_TERMS")) {
    out.push("EXPANSION_TOP_TERMS");
  }
  if (opts.vagueMinWords === VAGUE_MIN_WORDS && UNCALIBRATED_NAMES.has("VAGUE_MIN_WORDS")) {
    out.push("VAGUE_MIN_WORDS");
  }
  if (opts.vagueVeryShortWords === VAGUE_VERY_SHORT_WORDS && UNCALIBRATED_NAMES.has("VAGUE_VERY_SHORT_WORDS")) {
    out.push("VAGUE_VERY_SHORT_WORDS");
  }
  if (opts.cacheTtlSeconds === QUERY_REFORM_CACHE_TTL_SECONDS && UNCALIBRATED_NAMES.has("QUERY_REFORM_CACHE_TTL_SECONDS")) {
    out.push("QUERY_REFORM_CACHE_TTL_SECONDS");
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cache (in-memory LRU + TTL)
// ---------------------------------------------------------------------------

interface ReformulationResult {
  expanded: string;
  original: string;
  neighbors: Array<{ id: string; score: number }>;
  terms: Array<{ term: string; tfIdf: number; df: number }>;
  rrfApplied: boolean;
  fromCache: boolean;
  uncalibrated: string[];
  skipReason?: string;
}

interface CacheEntry {
  result: ReformulationResult;
  cachedAt: number;
}

const QUERY_CACHE = new Map<string, CacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;
let cacheCounterAtLastLog = 0;

/** Read (and reset) cache stats. Used by the logger for periodic reporting. */
export function readCacheStats(): { hits: number; misses: number; evictions: number } {
  const out = { hits: cacheHits, misses: cacheMisses, evictions: cacheEvictions };
  // Prevent unbounded growth of the delta-tracking state
  cacheHits = 0;
  cacheMisses = 0;
  cacheEvictions = 0;
  return out;
}

export function cacheGet(query: string, ttlMs: number): ReformulationResult | undefined {
  const entry = QUERY_CACHE.get(query);
  if (!entry) {
    cacheMisses++;
    return undefined;
  }
  if (Date.now() - entry.cachedAt > ttlMs) {
    QUERY_CACHE.delete(query);
    cacheEvictions++;
    cacheMisses++;
    return undefined;
  }
  cacheHits++;
  return { ...entry.result, fromCache: true };
}

export function cacheSet(query: string, result: ReformulationResult): void {
  // Evict oldest if over capacity
  if (QUERY_CACHE.size >= CACHE_MAX_SIZE) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of QUERY_CACHE) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      QUERY_CACHE.delete(oldestKey);
      cacheEvictions++;
    }
  }

  QUERY_CACHE.set(query, {
    result: { ...result, fromCache: false },
    cachedAt: Date.now(),
  });
}

function logCacheStats(log: { info: (event: string, fields?: Record<string, unknown>) => void }): void {
  // Use the stable readCacheStats + reset
  const stats = readCacheStats();
  const total = stats.hits + stats.misses;
  if (total === 0) return;
  log.info("query_reformulation_cache_stats", {
    hits: stats.hits,
    misses: stats.misses,
    evictions: stats.evictions,
    hitRate: total > 0 ? stats.hits / total : 0,
  });
}

export function maybeLogCacheStats(
  log?: { info: (event: string, fields?: Record<string, unknown>) => void },
): void {
  if (!log) return;
  const total = cacheHits + cacheMisses;
  if (total - cacheCounterAtLastLog < CACHE_STATS_INTERVAL) return;
  cacheCounterAtLastLog = total;
  logCacheStats(log);
}
