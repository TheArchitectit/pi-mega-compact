/**
 * @deprecated Import from `./api-contracts/index.js` (barrel) instead.
 * This file is retained for backward compatibility. All types are re-exported
 * from domain modules under `api-contracts/`.
 *
 * See: api-contracts/core.ts, snapshot.ts, multi-repo.ts, game.ts, infrastructure.ts
 */

// Re-export everything from the barrel
export type {
  // Core
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
  // Snapshot
  SnapshotResponse,
  TriggerResponse,
  CompressionTotalsResponse,
  CompactHistoryEntry,
  CompactionRequest,
  CompactionResponse,
  // Multi-repo
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
  // Game
  GameConfig,
  GameStateResponse,
  GameRitualStage,
  SseGameRitualStart,
  SseGameRitualStage,
  SseGameRitualEnd,
  SseGameModeChanged,
  SseGameRender,
  // Infrastructure
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
  // Composite
  SseEvent,
} from './api-contracts/index.js';
