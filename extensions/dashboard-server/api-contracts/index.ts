/**
 * api-contracts/index.ts — Barrel re-export for all API contract domains.
 *
 * Import from this file to access all types:
 *   import type { SnapshotResponse, RepoListItem } from '../api-contracts';
 *   // or explicitly:
 *   import type { SnapshotResponse } from '../api-contracts/snapshot';
 */

// Core types
export type {
	HttpMethod,
	EndpointDef,
	SseCompactStart,
	SseCompactEnd,
	SseCompactTrigger,
	SseCompactSkip,
	SseTierChanged,
	SseModelChanged,
	SsePressureLifted,
	SseCheckpointPersisted,
	SseRecallInject,
	SseHydeExecuted,
	SseRecallMetrics,
	SseAnchorsUpdated,
	SseConfigUpdated,
	SseConfigPreset,
	SseCrewPresenceChanged,
	SseCrewTurnChanged,
	SseCrewBanditChosen,
	SseSessionSample,
} from "./core.js";

// Snapshot / store / compression / session
export type {
	SnapshotResponse,
	TriggerResponse,
	CompressionTotalsResponse,
	CompactHistoryEntry,
	CompactionRequest,
	CompactionResponse,
} from "./snapshot.js";

// Multi-repo index and repo management
export type {
	RepoListItem,
	RepoSnapshotEntry,
	RepoSnapshotMap,
	IndexesIndexRow,
	IndexesSummaryResponse,
	IndexesDiffEntry,
	DiffRequest,
	SnapshotLike,
	DiffResponse,
	UpdateRepoConfigRequest,
} from "./multi-repo.js";

// Game mode and mega-game
export type {
	GameConfig,
	GameStateResponse,
	GameRitualStage,
	SseGameRitualStart,
	SseGameRitualStage,
	SseGameRitualEnd,
	SseGameModeChanged,
	SseGameRender,
} from "./game.js";

// Infrastructure, diagnostics, and monitoring
export type {
	InfraHealthResponse,
	InfraPerfSampleResponse,
	InfraRateLimitStatus,
	InfraRateLimitResponse,
	ContextLevelState,
	TierOverrideState,
	FallbackState,
	RepeatInjectionState,
	SupersedeGatingState,
	MinHashBandState,
} from "./infrastructure.js";

// Composite SSE event union (domain imports for type composition)
import type {
	SseGameRitualStart,
	SseGameRitualStage,
	SseGameRitualEnd,
	SseGameModeChanged,
	SseGameRender,
} from "./game.js";

import type {
	SseCompactStart,
	SseCompactEnd,
	SseCompactTrigger,
	SseCompactSkip,
	SseTierChanged,
	SseModelChanged,
	SsePressureLifted,
	SseCheckpointPersisted,
	SseRecallInject,
	SseHydeExecuted,
	SseRecallMetrics,
	SseAnchorsUpdated,
	SseConfigUpdated,
	SseConfigPreset,
	SseCrewPresenceChanged,
	SseCrewTurnChanged,
	SseCrewBanditChosen,
	SseSessionSample,
} from "./core.js";

import type {
	SseWikiRebuilt,
	SseWikiTopicRenamed,
	SseWikiTopicsMerged,
	SseWikiTopicSplit,
} from "./wiki.js";

// Endpoints registry (Sprint A1)
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
} from "./endpoints.js";
export type {
	ProviderCacheSavings,
	ProviderCacheResponse,
	ProviderCacheByModel,
} from "./provider-cache.js";

export { ENDPOINTS } from "./endpoints.js";

/** Union of all SSE event types the client may receive. */
export type SseEvent =
	| SseCompactStart
	| SseCompactEnd
	| SseCompactTrigger
	| SseCompactSkip
	| SseTierChanged
	| SseModelChanged
	| SsePressureLifted
	| SseCheckpointPersisted
	| SseRecallInject
	| SseAnchorsUpdated
	| SseConfigUpdated
	| SseConfigPreset
	| SseCrewPresenceChanged
	| SseCrewTurnChanged
	| SseCrewBanditChosen
	| SseHydeExecuted
	| SseRecallMetrics
	| SseGameRitualStart
	| SseGameRitualStage
	| SseGameRitualEnd
	| SseGameModeChanged
	| SseGameRender
	| SseSessionSample
	| SseWikiRebuilt
	| SseWikiTopicRenamed
	| SseWikiTopicsMerged
	| SseWikiTopicSplit;

// S49B — maintenance tab API
export type {
	TableStats,
	DbFiles,
	DbStorageStats,
	DbStatsResponse,
	MaintenanceActionResult,
	SchemaHealthRow,
	SchemaHealthResponse,
	MaintenanceAction,
	DebugBundleResponse,
} from "./maintenance.js";

// S52 — turn-by-turn memory tracking + recall + rewind
export type {
	TurnRow,
	RecallHit,
	ConversationSummary,
	TurnsResponse,
	ConversationTurnsResponse,
	RewindIntentsResponse,
	ForkRequest,
	ForkResponse,
	PostIntentRequest,
	PruneRequest,
	PruneTurnsResponse,
	TopicMemoriesResponse,
} from "./turns.js";

// S53B — memory effectiveness stats
export type { MemoryStatusResponse, MemoryStatsTopMemory } from "./memory.js";

// Setup wizard — embedder configuration + backend detection
export type { SetupStatusResponse, SetupDetectResponse, SetupConfigureRequest, SetupConfigureResponse, DetectResult, OllamaDetectResult } from "./setup.js";

// Embedder health probe
export type { EmbedderHealthResponse } from "./embedder-health.js";

// S46/D3 — memory graph (visual memory map) + validation report
export type {
	MemoryMapResponse,
	MemoryMapNode,
	MemoryMapEdgeEntry,
	MemoryMapQuery,
	GraphValidationReport,
} from "./memory-map.js";

// Part B — RAPTOR tree + build history
export type { RaptorNodeDTO, RaptorTreeResponse, RaptorBuildHistoryDTO, RaptorBuildHistoryResponse } from "./raptor.js";

// A3 — cache stripe distribution + health
export type {
	StripeBucket,
	CacheHealthScore,
	CacheStripesResponse,
} from "./cache-stripes.js";

// RAG Settings — comprehensive adjustable settings (B6)
export type {
	SettingState,
	SettingsResponse,
	SettingsUpdateRequest,
	SettingsResponsePost,
	RagFlagState,
	RagSettingsResponse,
	RagSettingsRequest,
	RagSettingsResponsePost,
} from "./rag-settings.js";

// RAG metrics — HyDE + recall-quality aggregations (H1/H2)
export type { RagMetricsResponse } from "./rag-metrics.js";

// W2 — wiki revival: curation + provenance
export type {
	WikiIndexEntry,
	WikiIndexResponse,
	MemoryProvenance,
	WikiPageResponse,
	RenameTopicRequest,
	MergeTopicsRequest,
	SplitTopicRequest,
	TopicTimelineResponse,
	TopicEvolutionResponse,
	TopicEvolutionNode,
	TopicEvolutionEdge,
	SseWikiRebuilt,
	SseWikiTopicRenamed,
	SseWikiTopicsMerged,
	SseWikiTopicSplit,
	WikiSseEvent,
} from "./wiki.js";
export type { CurationResult, OverrideKind, WikiCurationStore } from "../../../src/wiki/curation.js";
