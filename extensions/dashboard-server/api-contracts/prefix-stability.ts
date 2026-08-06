/**
 * api-contracts/prefix-stability.ts — Prompt-cache prefix-stability API contract (PC-C).
 *
 * Response shape for GET /api/prefix-stability?limit=50: per-turn stable-prefix
 * ratio trend surfaced from the local monitoring events log (prefix_stability rows
 * appended by tailResult.ts). Loopback-only data; zero network (PREVENT-PI-004).
 */

/** A single per-turn prefix-stability sample. */
export interface PrefixStabilitySample {
	/** Monotonic turn index (order of emission, 0-based). */
	readonly turnIndex: number;
	/** Number of messages sharing the stable prefix (cache-able head). */
	readonly stablePrefix: number;
	/** Total messages in the assembled prompt for that turn. */
	readonly totalMessages: number;
	/** stablePrefix / totalMessages (0.0–1.0); 0 when totalMessages is 0. */
	readonly ratio: number;
	/** Ollama-style striping mode at emit time: "v3" (cache-striping) | "v2" | "off". */
	readonly striping: string;
	/** ISO-8601 timestamp of the event (from the events log row). */
	readonly timestamp: string;
}

/** Three-point trend classification across the returned window. */
export type PrefixStabilityTrend = "improving" | "stable" | "degrading";

/** Response body for GET /api/prefix-stability. */
export interface PrefixStabilityResponse {
	/** Per-turn samples in chronological order (oldest first), at most `limit`. */
	readonly turns: PrefixStabilitySample[];
	/** Mean ratio across returned samples (0.0–1.0); 0 when empty. */
	readonly avgRatio: number;
	/** Trend classification of the tail of the window vs its head. */
	readonly trend: PrefixStabilityTrend;
	/** Number of samples returned. */
	readonly count: number;
	/** Epoch-millis timestamp the endpoint last scanned the events log. */
	readonly lastScanAt: number;
}
