/**
 * api-contracts/core.ts — Core types shared across all API domains.
 *
 * Contains: generic endpoint definition, HTTP method, SSE event types.
 * Extracted from api-contracts.ts (Sprint A1 split).
 */

// ─── Endpoint Method ────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'PUT' | 'POST';

// ─── Generic Endpoint Definition ────────────────────────────────────────────

export interface EndpointDef<M extends HttpMethod, Req, Res> {
  readonly method: M;
  readonly path: string;
  readonly description: string;
  readonly requestSchema?: Req;
  readonly responseSchema?: Res;
}

// ─── SSE Event Types ────────────────────────────────────────────────────────

export interface SseCompactStart {
  type: 'compact_start';
  ts: string;
  trigger: 'auto' | 'manual' | 'fast-gate' | 'ctx-pressure';
  sessionId: string;
}

export interface SseCompactEnd {
  type: 'compact_end';
  ts: string;
  sessionId: string;
  checkpointId: string;
  tokensIn: number;
  tokensOut: number;
  tokensFreed: number;
  success: boolean;
}

export interface SseCompactTrigger {
  type: 'compact_trigger';
  ts: string;
  pressure: number;
  threshold: number;
  armed: boolean;
}

export interface SseCompactSkip {
  type: 'compact_skip';
  ts: string;
  reason: string;
}

export interface SseTierChanged {
  type: 'tier_changed';
  ts: string;
  from: string;
  to: string;
  contextPct: number;
}

export interface SseModelChanged {
  type: 'model_changed';
  ts: string;
  provider: string;
  providerName: string;
  model: string;
}

export interface SsePressureLifted {
  type: 'pressure_lifted';
  ts: string;
  beforePct: number;
  afterPct: number;
}

export interface SseCheckpointPersisted {
  type: 'checkpoint_persisted';
  ts: string;
  checkpointId: string;
  sessionTokens: number;
}

export interface SseRecallInject {
  type: 'recall_inject';
  ts: string;
  query: string;
  chunks: number;
  tokens: number;
}

export interface SseAnchorsUpdated {
  type: 'anchors_updated';
  ts: string;
  count: number;
  pinned: number;
}

export interface SseConfigUpdated {
  type: 'config_updated';
  ts: string;
  key: string;
  value: unknown;
}

export interface SseConfigPreset {
  type: 'config_preset';
  ts: string;
  preset: string;
}

export interface SseCrewPresenceChanged {
  type: 'crew_presence_changed';
  ts: string;
  activeAgents: number;
  currentTurn: number;
}

export interface SseCrewTurnChanged {
  type: 'crew_turn_changed';
  ts: string;
  turnIndex: number;
  agentName: string;
}

export interface SseCrewBanditChosen {
  type: 'crew_bandit_chosen';
  ts: string;
  chosenAgent: string;
  score: number;
  regret: number;
}
