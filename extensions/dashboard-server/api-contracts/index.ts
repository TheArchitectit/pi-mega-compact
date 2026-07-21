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
  SseAnchorsUpdated,
  SseConfigUpdated,
  SseConfigPreset,
  SseCrewPresenceChanged,
  SseCrewTurnChanged,
  SseCrewBanditChosen,
} from './core.js';

// Snapshot / store / compression / session
export type {
  SnapshotResponse,
  TriggerResponse,
  CompressionTotalsResponse,
  CompactHistoryEntry,
  CompactionRequest,
  CompactionResponse,
} from './snapshot.js';

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
} from './multi-repo.js';

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
} from './game.js';

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
} from './infrastructure.js';

// Composite SSE event union (domain imports for type composition)
import type {
  SseGameRitualStart,
  SseGameRitualStage,
  SseGameRitualEnd,
  SseGameModeChanged,
  SseGameRender,
} from './game.js';

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
  SseAnchorsUpdated,
  SseConfigUpdated,
  SseConfigPreset,
  SseCrewPresenceChanged,
  SseCrewTurnChanged,
  SseCrewBanditChosen,
} from './core.js';

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
  PerfCacheHit,
  PerfDiag,
  PerfQuery,
  PerfResponse,
  GameScoreRow,
  GameScoresQuery,
  AchievementRow,
  GameStatePatch,
  SseEndpointDef,
} from './endpoints.js';

export { ENDPOINTS } from './endpoints.js';

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
  | SseGameRitualStart
  | SseGameRitualStage
  | SseGameRitualEnd
  | SseGameModeChanged
  | SseGameRender;
