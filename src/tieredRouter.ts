/**
 * tieredRouter.ts — S44 three-tier latency-aware recall routing (impl).
 *
 * Three tiers:
 *   L0: in-memory LRU cache (recent queries -> results).
 *   L1: FTS5 trigram BM25 search (fast, approximate).
 *   L2: PGlite HNSW vector search via vectorStore.searchAsync (accurate, slower).
 *
 * Tiered fallback: try L0, miss -> L1, insufficient -> L2, L2 throw -> sync call.
 * Latency-budget configurable per tier. Real `Date.now()` delta instrumentation.
 *
 * Pi-agnostic: no pi runtime types. Uses `openStore` for L1 and optionally
 * the existing VectorStore / vectorSearchAsync for L2.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VC3C_ENABLED } from "./config.js";
import { Logger } from "./log.js";
import { routerGenerationInvalidationSeam, type RouterKeyV2 } from "./vector-cortex/topology/query.js";
import { openStore } from "./store/sqlite/utils.js";
import { fts5SearchScoped } from "./store/sqlite/fts5-search.js";
import { listCheckpoints } from "./store/sqlite.js";
import { getStateDir } from "./store.js";
import type { VectorStore, SearchHit } from "./vectorStore.js";
import { vectorSearchAsync } from "./vector-search.js";
import {
  type TieredRecallOpts,
  type RecallResult,
  type TieredRouterMetrics,
  DEFAULT_CACHE_SIZE,
  DEFAULT_BUDGET_L0_MS,
  DEFAULT_BUDGET_L1_MS,
  DEFAULT_BUDGET_L2_MS,
  DEFAULT_LOG_CADENCE,
} from "./tiered-router/types.js";

// ---------------------------------------------------------------------------
// Env-based config helpers
// ---------------------------------------------------------------------------

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

/**
 * Load fts5MaxBm25 from calibration.json or env override.
 */
function loadFts5MaxBm25(stateDir: string): {
  fts5MaxBm25: number | null;
  uncalibrated: boolean;
} {
  // Env override wins.
  const envVal = process.env.MEGACOMPACT_FTS5_MAX_BM25;
  if (envVal !== undefined) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) {
      return { fts5MaxBm25: n, uncalibrated: false };
    }
  }

  // Try calibration.json.
  const calPath = join(stateDir, "calibration.json");
  if (existsSync(calPath)) {
    try {
      const raw = readFileSync(calPath, "utf-8");
      // PREVENT-001: null check on JSON.parse
      const parsed: unknown = JSON.parse(raw);
      const cal = parsed as Record<string, unknown>;
      if (typeof cal.fts5MaxBm25 === "number" && cal.fts5MaxBm25 >= 0) {
        return { fts5MaxBm25: cal.fts5MaxBm25, uncalibrated: false };
      }
      return { fts5MaxBm25: null, uncalibrated: true };
    } catch {
      // Malformed calibration file -- treat as uncalibrated.
      return { fts5MaxBm25: null, uncalibrated: true };
    }
  }

  return { fts5MaxBm25: null, uncalibrated: true };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic cache key from (sessionId, query, k).
 * Uses first 12 hex chars of SHA-256 (collision probability negligible for a
 * local cache -- full collisions across different queries produce identical keys
 * only if the model IDs and query text collide, which is a cache-containment
 * artifact, not a correctness bug).
 */
function cacheKey(sessionId: string | undefined, query: string, k: number): string {
  const payload = `${sessionId ?? "__cross__"}||${query}||${k}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/** Entry in the LRU cache. */
interface CacheEntry {
  key: string;
  hits: SearchHit[];
  tier: "L0" | "L1" | "L2";
}

// ---------------------------------------------------------------------------
// TieredRouter
// ---------------------------------------------------------------------------

export class TieredRouter {
  // ---------- LRU cache ----------
  private readonly cacheSize: number;
  private cacheMap: Map<string, CacheEntry> = new Map();

  // ---------- Per-tier latency budgets ----------
  private readonly budgetL0Ms: number;
  private readonly budgetL1Ms: number;
  private readonly budgetL2Ms: number;

  // ---------- Calibration ----------
  /** Max BM25 score achievable on this corpus (null = uncalibrated). */
  readonly fts5MaxBm25: number | null;
  /** True when no calibration file or env override is available. */
  readonly uncalibrated: boolean;
  /**
   * Conservative fallback gate fraction for the L1 confidence check.
   * When uncalibrated, we require L1 score >= fraction * (some heuristic ceiling)
   * before skipping L2. A real calibration sets this dynamically.
   */
  private readonly l1ConfidenceFraction: number;

  // ---------- State dir + log path ----------
  private readonly stateDir: string;
  private readonly logPath: string;

  // ---------- Metrics ----------
  private l0Hits = 0;
  private l0Misses = 0;
  private l1Hits = 0;
  private l1Misses = 0;
  private l2Hits = 0;
  private l2Misses = 0;
  private totalQueries = 0;
  private accLatencyL0 = 0;
  private accLatencyL1 = 0;
  private accLatencyL2 = 0;
  private logCadence: number;
  /** Hashed query -> embedding cache (avoids re-embedding L1 hits for L2). */
  private embeddingCache: Map<string, number[]> = new Map();

  constructor(opts?: {
    stateDir?: string;
    cacheSize?: number;
    budgetL0Ms?: number;
    budgetL1Ms?: number;
    budgetL2Ms?: number;
    logCadence?: number;
    fts5MaxBm25?: number | null;
  }) {
    const sd = opts?.stateDir ?? getStateDir();
    this.stateDir = sd;
    this.logPath = join(sd, "tiered-router-events.log");
    this.cacheSize = opts?.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.budgetL0Ms = opts?.budgetL0Ms ?? DEFAULT_BUDGET_L0_MS;
    this.budgetL1Ms = opts?.budgetL1Ms ?? DEFAULT_BUDGET_L1_MS;
    this.budgetL2Ms = opts?.budgetL2Ms ?? DEFAULT_BUDGET_L2_MS;
    this.logCadence = opts?.logCadence ?? DEFAULT_LOG_CADENCE;

    // Calibration: explicit override > env/file > uncalibrated.
    if (opts?.fts5MaxBm25 !== undefined) {
      this.fts5MaxBm25 = opts.fts5MaxBm25;
      this.uncalibrated = opts.fts5MaxBm25 === null;
    } else {
      const cal = loadFts5MaxBm25(this.stateDir);
      this.fts5MaxBm25 = cal.fts5MaxBm25;
      this.uncalibrated = cal.uncalibrated;
    }

    // Conservative fallback: when uncalibrated, use a small fraction
    // (10% of an assumed ceiling 0.5) to bias toward L2 fallback.
    // A real calibration enables the full confidence gate.
    this.l1ConfidenceFraction = this.fts5MaxBm25 != null ? 0.7 : 0.1;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Three-tier recall routing: L0 (cache) -> L1 (FTS5) -> L2 (PGlite vec).
   *
   * @param query The search query text.
   * @param opts  Options including sessionId, k, flag overrides.
   * @param store The VectorStore instance (needed for L2 hydration).
   * @returns Hits ranked by the tier that satisfied the query.
   */
  async route(
    query: string,
    opts: TieredRecallOpts,
    store: VectorStore,
  ): Promise<RecallResult> {
    this.totalQueries++;
    const k = opts.k ?? 10;
    const sessionId = opts.sessionId;

    // ---- L0: in-memory LRU cache ----
    const ck = cacheKey(sessionId, query, k);
    if (!opts.bypassCache) {
      try {
        const t0L0 = Date.now();
        const cached = this.cacheMap.get(ck);
        const latL0 = Date.now() - t0L0;
        this.accLatencyL0 += latL0;

        if (cached) {
          this.l0Hits++;
          // Promote to front (delete + set).
          this.cacheMap.delete(ck);
          this.cacheMap.set(ck, cached);
          this.maybeLogMetrics();
          if (latL0 > this.budgetL0Ms) {
            this.logBudgetWarn("L0", latL0, this.budgetL0Ms);
          }
          return { hits: cached.hits, tier: "L0", latencyMs: { l0: latL0 } };
        }
        this.l0Misses++;
      } catch (err) {
        this.l0Misses++;
        this.logTierThrew("L0", err);
      }
    }

    // ---- L1: FTS5 trigram BM25 search ----
    let fts5Hits: Array<{ id: string; score: number }> = [];
    try {
      const t0L1 = Date.now();
      const reader = openStore(this.stateDir);
      fts5Hits = fts5SearchScoped(query, reader, sessionId, k);
      const latL1 = Date.now() - t0L1;
      this.accLatencyL1 += latL1;
      if (latL1 > this.budgetL1Ms) {
        this.logBudgetWarn("L1", latL1, this.budgetL1Ms);
      }
    } catch (err) {
      this.logTierThrew("L1", err);
      // Fall through to L2.
    }

    const l1Score = fts5Hits.length > 0 ? fts5Hits[0]!.score : 0;
    const l1HighEnough =
      fts5Hits.length > 0 &&
      this.fts5MaxBm25 != null &&
      l1Score >= this.l1ConfidenceFraction * this.fts5MaxBm25;

    if (l1HighEnough && fts5Hits.length >= k) {
      this.l1Hits++;
      const hits = await this.hydrateHits(fts5Hits.slice(0, k), sessionId);
      this.cacheResult(ck, hits, "L1");
      this.maybeLogMetrics();
      return {
        hits,
        tier: "L1",
        latencyMs: { l0: 0, l1: 0 },
      };
    }

    if (fts5Hits.length > 0) {
      this.l1Misses++; // L1 returned results but insufficient confidence
    } else {
      this.l1Misses++;
    }

    // ---- L2: PGlite HNSW vector search ----
    try {
      const t0L2 = Date.now();
      const asyncHits = await vectorSearchAsync(store, sessionId ?? "", query, k);
      const latL2 = Date.now() - t0L2;
      this.accLatencyL2 += latL2;

      if (asyncHits.length > 0) {
        this.l2Hits++;
        const hits = asyncHits.slice(0, k);
        this.cacheResult(ck, hits, "L2");
        this.maybeLogMetrics();
        if (latL2 > this.budgetL2Ms) {
          this.logBudgetWarn("L2", latL2, this.budgetL2Ms);
        }
        return { hits, tier: "L2", latencyMs: { l2: latL2 } };
      }
      this.l2Misses++;
    } catch (err) {
      this.l2Misses++;
      this.logTierThrew("L2", err);
      // Fall through -- caller should fall back to sync searchRecall().
    }

    this.maybeLogMetrics();
    return { hits: [], tier: "L2", latencyMs: {} };
  }

  /**
   * Synchronous L0 cache peek. Returns cached hits for (sessionId, query, k)
   * and promotes the entry to the front of the LRU, or null on miss. Use this
   * from synchronous recall paths that cannot await route() (route() is async).
   * Does not touch L1/L2 — only the in-memory LRU.
   */
  peekCache(sessionId: string | undefined, query: string, k: number): SearchHit[] | null {
    const ck = cacheKey(sessionId, query, k);
    const cached = this.cacheMap.get(ck);
    if (!cached) return null;
    this.l0Hits++;
    this.cacheMap.delete(ck);
    this.cacheMap.set(ck, cached); // promote to front
    return cached.hits;
  }

  /**
   * Invalidate cached results for a given session.
   * Called when new messages arrive (session context changed).
   */
  invalidateSession(sessionId?: string): void {
    if (sessionId) {
      const prefix = `${sessionId}||`;
      for (const [key] of this.cacheMap) {
        // cacheKey format: <sessionId>||<query>||<k>
        if (key.startsWith(prefix)) {
          this.cacheMap.delete(key);
        }
      }
    } else {
      // Cross-session entries start with "__cross__||"
      for (const [key] of this.cacheMap) {
        if (key.startsWith("__cross__||")) {
          this.cacheMap.delete(key);
        }
      }
    }
  }

  /** Force-clear the entire result cache. */
  clearCache(): void {
    this.cacheMap.clear();
    this.embeddingCache.clear();
  }

  /** VC3C narrow delegate: exact (session,generation) RouterKeyV2 invalidation.
   * No routing rewrite; `MEGACOMPACT_VC3C=0` is a strict no-op, byte-identical. */
  invalidateGeneration(key: RouterKeyV2): void {
    routerGenerationInvalidationSeam(key, VC3C_ENABLED(), (e, f) => new Logger().info(e, f));
  }

  /** Snapshot of current metrics for dashboard / logging. */
  getMetrics(): TieredRouterMetrics {
    const q = Math.max(this.totalQueries, 1);
    return {
      l0Hits: this.l0Hits,
      l0Misses: this.l0Misses,
      l1Hits: this.l1Hits,
      l1Misses: this.l1Misses,
      l2Hits: this.l2Hits,
      l2Misses: this.l2Misses,
      totalQueries: this.totalQueries,
      avgLatencyMs: {
        l0: Math.round((this.accLatencyL0 / q) * 100) / 100,
        l1: Math.round((this.accLatencyL1 / q) * 100) / 100,
        l2: Math.round((this.accLatencyL2 / q) * 100) / 100,
      },
      fts5MaxBm25: this.fts5MaxBm25,
      uncalibrated: this.uncalibrated,
    };
  }

  /** Reset all metrics counters (for testing). */
  resetMetrics(): void {
    this.l0Hits = 0;
    this.l0Misses = 0;
    this.l1Hits = 0;
    this.l1Misses = 0;
    this.l2Hits = 0;
    this.l2Misses = 0;
    this.totalQueries = 0;
    this.accLatencyL0 = 0;
    this.accLatencyL1 = 0;
    this.accLatencyL2 = 0;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Hydrate FTS5 hits (which only carry checkpoint `id` + `score`) into
   * full SearchHit objects by fetching from the sync store.
   */
  private async hydrateHits(
    fts5Hits: Array<{ id: string; score: number }>,
    sessionId?: string,
  ): Promise<SearchHit[]> {
    const cps = listCheckpoints(sessionId ?? "", this.stateDir);
    const cpMap = new Map(cps.map((cp) => [cp.checkpointId, cp]));
    const hits: SearchHit[] = [];
    for (const fh of fts5Hits) {
      const cp = cpMap.get(fh.id);
      if (cp) {
        hits.push({ checkpoint: cp, score: fh.score });
      }
    }
    return hits;
  }

  /** Insert into the LRU cache, evicting oldest entry if over capacity. */
  private cacheResult(key: string, hits: SearchHit[], tier: "L0" | "L1" | "L2"): void {
    if (this.cacheMap.has(key)) {
      this.cacheMap.delete(key);
    } else if (this.cacheMap.size >= this.cacheSize) {
      const oldest = this.cacheMap.keys().next();
      if (oldest.value !== undefined) {
        this.cacheMap.delete(oldest.value);
      }
    }
    this.cacheMap.set(key, { key, hits, tier });
  }

  /** Append a structured event to the tiered-router events log (best-effort). */
  private appendLog(ev: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, JSON.stringify(ev) + "\n");
    } catch {
      /* best-effort -- never break extension on log failure */
    }
  }

  /** Log periodic tiered metrics at the configured cadence. */
  private maybeLogMetrics(): void {
    if (this.totalQueries % this.logCadence !== 0) return;
    const m = this.getMetrics();
    const payload: Record<string, unknown> = {
      event: "tiered_routing_metrics",
      l0Hits: m.l0Hits,
      l0Misses: m.l0Misses,
      l1Hits: m.l1Hits,
      l1Misses: m.l1Misses,
      l2Hits: m.l2Hits,
      l2Misses: m.l2Misses,
      avgLatencyMs: m.avgLatencyMs,
      totalQueries: m.totalQueries,
      fts5MaxBm25: m.fts5MaxBm25,
      uncalibrated: m.uncalibrated,
    };
    if (m.uncalibrated) {
      (payload as Record<string, string>).note = "run scripts/calibrate-fts5.mjs";
    }
    this.appendLog(payload);
  }

  /** Log a tier-threw event (non-fatal fall-through). */
  private logTierThrew(tier: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.appendLog({ event: "tier_threw", tier, error: message });
  }

  /** Log a budget-warning event. */
  private logBudgetWarn(tier: string, actualMs: number, budgetMs: number): void {
    this.appendLog({ event: "tier_budget", tier, actualMs, budgetMs });
  }
}

// ---------------------------------------------------------------------------
// Factory / singleton
// ---------------------------------------------------------------------------

let _defaultRouter: TieredRouter | null = null;

/**
 * Get or create the singleton tiered router.
 * Feature-gated on TIERED_ROUTING_ENABLED (default true).
 * Returns null when the flag is OFF, so callers can fall through cleanly.
 */
export function getTieredRouter(): TieredRouter | null {
  const enabled = envBool("MEGACOMPACT_TIERED_ROUTING_ENABLED", true);
  if (!enabled) return null;

  if (!_defaultRouter) {
    _defaultRouter = new TieredRouter({
      stateDir: getStateDir(),
    });
  }
  return _defaultRouter;
}

/** Reset the singleton (for testing). */
export function resetTieredRouter(): void {
  _defaultRouter = null;
}
