/**
 * api-contracts/endpoints.ts — Central registry of all dashboard API endpoints.
 *
 * Delegate-shell (extensions split): single source of truth for all dashboard
 * API routes. The inline response types + game-types re-exports live in
 * ./endpoints/types.ts and the ENDPOINTS object literal in ./endpoints/registry.ts;
 * this pointer re-exports the full public surface unchanged.
 *
 * Sprint A1 — PREVENT-PI-004: zero network code (type definitions only).
 * PREVENT-011: no `any` type — all types are explicit.
 */

export type {
	VersionResponse,
	IndexSummary,
	IndexFallbackResponse,
	ReposQuery,
	ReposResponse,
	SummaryResponse,
	DriftSeverity,
	DriftSignal,
	RepoDrift,
	DriftReportResponse,
	ServerEntry,
	ServersResponse,
	PerfPercentile,
	PerfAverage,
	PerfLatest,
	CacheHitSample,
	PerfCacheHit,
	PerfDiag,
	PerfQuery,
	PerfResponse,
	GameScoreRow,
	GameScoresQuery,
	AchievementRow,
	GameStatePatch,
	ActiveSession,
	SessionsResponse,
	SessionDataPoint,
	SessionSeries,
	SessionTimeseriesQuery,
	SessionTimeseriesResponse,
	SseEndpointDef,
	TopicRow,
	TopicAssignmentRow,
	TopicsResponse,
	TopicDetailResponse,
} from "./endpoints/types.js";

export { ENDPOINTS } from "./endpoints/registry.js";
