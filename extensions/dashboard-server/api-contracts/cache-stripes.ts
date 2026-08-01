/**
 * api-contracts/cache-stripes.ts — Cache stripe API contract (A3, PLAN_V2 Phase 4).
 *
 * Response shape for GET /api/cache-stripes: per-stripe distribution counts,
 * average stability, and a top-level health score. Loopback-only data;
 * zero network (PREVENT-PI-004).
 */

/** A single stripe bucket with aggregate metadata. */
export interface StripeBucket {
	/** Stripe index 0–4 (0=permanent, 1=epoch, 2=topic, 3=thread, 4=volatile). */
	readonly stripe: number;
	/** Human-readable label for this stripe. */
	readonly label: string;
	/** Number of chunks assigned to this stripe. */
	readonly count: number;
	/** Average stability score (0.0–1.0) within this stripe. */
	readonly avgStability: number;
	/** Minimum stability in this stripe. */
	readonly minStability: number;
	/** Maximum stability in this stripe. */
	readonly maxStability: number;
}

/** Overall cache health assessment. */
export interface CacheHealthScore {
	/** Composite health score 0.0–1.0 (1.0 = perfect). */
	readonly score: number;
	/** Human-readable label: "good" | "fair" | "degraded" | "poor". */
	readonly label: string;
	/** Dominant stability tier fraction. */
	readonly dominantTier: number;
	/** Stripe churn rate (0.0–1.0) — fraction of assignments changed since last epoch. */
	readonly churnRate: number;
}

/** Response body for GET /api/cache-stripes. */
export interface CacheStripesResponse {
	/** Per-stripe bucket arrays (always 5 entries, stripes 0–4). */
	readonly buckets: StripeBucket[];
	/** Overall health assessment. */
	readonly health: CacheHealthScore;
	/** Epoch id these assignments belong to. */
	readonly epochId: string | null;
	/** Timestamp (epoch ms) of the last refresh. */
	readonly lastRefreshAt: number;
	/** Total chunk count across all stripes. */
	readonly totalChunks: number;
}
