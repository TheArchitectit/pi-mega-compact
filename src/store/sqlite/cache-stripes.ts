/**
 * src/store/sqlite/cache-stripes.ts — Cache stripe distribution reader (A3, PLAN_V2 Phase 4).
 *
 * Reads from the cache_stripes table (schema.ts) to produce stripe distribution
 * stats, stability aggregates, and a composite health score. Pi-agnostic.
 *
 * PREVENT-002: all queries use parameterized SQL.
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

// ---------------------------------------------------------------------------
// Types (mirrors api-contracts/cache-stripes.ts but as a plain domain type).
// ---------------------------------------------------------------------------

export interface StripeBucket {
  readonly stripe: number;
  readonly label: string;
  readonly count: number;
  readonly avgStability: number;
  readonly minStability: number;
  readonly maxStability: number;
}

export interface CacheHealthScore {
  readonly score: number;
  readonly label: string;
  readonly dominantTier: number;
  readonly churnRate: number;
}

export interface CacheStripesResult {
  readonly buckets: StripeBucket[];
  readonly health: CacheHealthScore;
  readonly epochId: string | null;
  readonly lastRefreshAt: number;
  readonly totalChunks: number;
}

/** Human-readable labels for each stripe tier (0=permanent .. 4=volatile). */
const STRIPE_LABELS: Record<number, string> = {
  0: "Permanent",
  1: "Epoch",
  2: "Topic",
  3: "Thread",
  4: "Volatile",
};

/** Weight per stripe for health scoring (higher = more stable = better). */
const STRIPE_HEALTH_WEIGHTS: Record<number, number> = {
  0: 1.0,
  1: 0.8,
  2: 0.5,
  3: 0.25,
  4: 0.0,
};

/**
 * Read cache stripe distribution from the database.
 *
 * Returns aggregated per-stripe buckets with stability stats and a composite
 * health score. Returns empty buckets (all zeros) when the table is empty,
 * so the dashboard always has a valid response.
 */
export function readCacheStripes(
  stateDir: string = getStateDir(),
): CacheStripesResult {
  const db = openStore(stateDir);

  // ── Fetch per-stripe aggregates ──
  const rows = db
    .prepare(
      `SELECT
         stripe,
         COUNT(*)                                         AS count,
         ROUND(AVG(stability), 4)                         AS avgStability,
         ROUND(MIN(stability), 4)                         AS minStability,
         ROUND(MAX(stability), 4)                         AS maxStability
       FROM cache_stripes
       GROUP BY stripe
       ORDER BY stripe ASC`,
    )
    .all() as Array<{
    stripe: number;
    count: number;
    avgStability: number;
    minStability: number;
    maxStability: number;
  }>;

  // ── Latest epoch ──
  const epochRow = db
    .prepare(
      `SELECT epoch_id, MAX(assigned_at) AS last_refresh
       FROM cache_stripes
       WHERE epoch_id IS NOT NULL`,
    )
    .get() as { epoch_id: string; last_refresh: number } | undefined;

  // ── Total chunk count ──
  const totalRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM cache_stripes")
    .get() as { cnt: number };

  const totalChunks = totalRow?.cnt ?? 0;

  // ── Build bucket array (always 5 entries, stripe 0–4) ──
  const rowMap = new Map<number, (typeof rows)[number]>();
  for (const r of rows) rowMap.set(r.stripe, r);

  const buckets: StripeBucket[] = [];
  for (let s = 0; s <= 4; s++) {
    const r = rowMap.get(s);
    buckets.push({
      stripe: s,
      label: STRIPE_LABELS[s] ?? `Stripe ${s}`,
      count: r?.count ?? 0,
      avgStability: r?.avgStability ?? 0,
      minStability: r?.minStability ?? 0,
      maxStability: r?.maxStability ?? 0,
    });
  }

  // ── Compute health score ──
  const health = computeCacheHealth(buckets, totalChunks, stateDir);

  return {
    buckets,
    health,
    epochId: epochRow?.epoch_id ?? null,
    lastRefreshAt: epochRow?.last_refresh ?? 0,
    totalChunks,
  };
}

/**
 * Compute cache health from bucket distribution.
 *
 * Score = weighted sum of stripe fractions (normalised 0..1).
 * Dominant tier = fraction of chunks in the top 2 stripes (0+1).
 * Label: >= 0.8 = good, >= 0.6 = fair, >= 0.4 = degraded, else poor.
 */
function computeCacheHealth(
  buckets: StripeBucket[],
  total: number,
  stateDir: string,
): CacheHealthScore {
  if (total === 0) {
    return { score: 1, label: "good", dominantTier: 1, churnRate: 0 };
  }

  let weightedSum = 0;
  let dominantCount = 0;

  for (const b of buckets) {
    const w = STRIPE_HEALTH_WEIGHTS[b.stripe] ?? 0;
    weightedSum += (b.count / total) * w;
    if (b.stripe <= 1) dominantCount += b.count;
  }

  const dominantTier = dominantCount / total;

  // ── Churn rate: open a new DB connection for the churn query ──
  let churnRate = 0;
  try {
    const churnDb = openStore(stateDir);
    const churnRow = churnDb
      .prepare(
        `WITH
          ranked AS (
            SELECT chunk_id, epoch_id,
                   ROW_NUMBER() OVER (PARTITION BY chunk_id ORDER BY assigned_at DESC) AS rn
            FROM cache_stripes
          ),
          cur AS (SELECT chunk_id, epoch_id FROM ranked WHERE rn = 1),
          prev AS (SELECT chunk_id, epoch_id FROM ranked WHERE rn = 2)
        SELECT
          COUNT(*) AS total_changed
        FROM cur c
        JOIN prev p ON c.chunk_id = p.chunk_id AND c.epoch_id != p.epoch_id`,
      )
      .get() as { total_changed: number } | undefined;

    if (churnRow && total > 0) {
      churnRate = Math.min(1, (churnRow.total_changed ?? 0) / total);
    }
  } catch {
    // churn unavailable — keep 0
  }

  const score = Math.round(weightedSum * 100) / 100;
  const label =
    score >= 0.8 ? "good" : score >= 0.6 ? "fair" : score >= 0.4 ? "degraded" : "poor";

  return { score, label, dominantTier, churnRate };
}
