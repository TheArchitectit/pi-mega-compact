/**
 * analytics.ts — PMA-3 dashboard response contracts for analytics endpoints.
 *
 * These are the dashboard-facing types (nullable = N/A semantics per spec §10),
 * distinct from the store's internal types in src/store/analytics/types.ts.
 */

/** Response for GET /api/analytics/status — store health + counts. */
export interface AnalyticsStatusResponse {
	enabled: boolean;
	schemaVersion: number;
	requestEventCount: number;
	measurementCount: number;
	identityCount: number;
	/** Epoch ms of the most recent fact, or null when empty (N/A). */
	freshThrough: number | null;
}

/** A single request event in a detailed response. */
export interface AnalyticsEventRow {
	id: string;
	correlationId: string | null;
	sessionId: string | null;
	eventKind: string;
	observedAt: number;
	provider: string | null;
	model: string | null;
	status: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	durationMs: number | null;
	ttftMs: number | null;
}

/** Response for GET /api/analytics/detailed — filterable request-event page. */
export interface AnalyticsDetailedResponse {
	events: AnalyticsEventRow[];
	total: number;
	hasMore: boolean;
	generatedAt: number;
	/** The filter window applied (null = unbounded). */
	window: { fromMs: number | null; toMs: number | null };
}
