/**
 * mega-dashboard.ts — live dashboard snapshot writer.
 *
 * Writes dashboard.json (full snapshot) and events.log (JSONL tail) to the
 * state dir so any process can inspect the extension's real-time state.
 *
 * Usage:
 *   cat ~/.pi/agent/extensions/pi-mega-compact/dashboard.json
 *   jq . ~/.pi/agent/extensions/pi-mega-compact/dashboard.json
 *   tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log
 *
 * Standalone: the snapshot *shape* is filled in by MegaRuntime.snapshot();
 * this module only owns the on-disk write/append mechanics.
 */

import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";

export interface DashboardSnapshot {
  version: 1;
  updatedAt: string;
  tier: string;
  config: {
    fastGatePct: number;
    thresholdTokens: number;
    anchorUserMessages: number;
    preserveRecent: number;
    auto: boolean;
    autoInline: boolean;
  };
  session: {
    id: string;
    state: string;
    persistedThisSession: boolean;
    lastCheckpointId: string | null;
    lastCompactedFrom: number;
    lastCompactedTokens: number;
    dedupSkips: number;
    dedupAttempts: number;
  };
  context: {
    tokens: number | null;
    percent: number | null;
    contextWindow: number;
  };
  trigger: {
    armed: boolean;           // past fast-gate %
    ready: boolean;           // past threshold (would compact next turn)
    currentTokens: number | null;
    thresholdTokens: number;
    fastGatePct: number;
  };
  store: {
    checkpointCount: number;
    totalTokenEstimate: number;
    originalTokens: number;      // Σ original dropped-region tokens (this session)
    tokensSaved: number;         // Σ(original − stored) for this session
    injectedCount: number;
    dedupHitRate: number;
    storageDedupRate: number;
    dedupAttempts: number;
    dedupCollapsed: number;
  };
  crew: {
    activeAgents: number;
    currentTurn: number;
  };
  repo: {
    checkpointCount: number;     // across all sessions in this repo's store
    totalTokenEstimate: number;  // repo-wide stored checkpoint tokens
    originalTokens: number;      // repo-wide Σ original dropped-region tokens
    tokensSaved: number;         // repo-wide cumulative (original − stored) + deduped orig
    sessionCount: number;        // distinct sessions with checkpoints
    dedupAttempts: number;       // cumulative add() calls (store-wide)
    dedupCollapsed: number;      // cumulative deduped collapses (store-wide)
    storageDedupRate: number;    // deduped / attempts, 0..1
  };
  /** Phase 0 data-safety invariant (trust foundation). */
  integrity: {
    regionsRetained: number;         // checkpoints with a recoverable compressed-original
    compressedOriginalBytes: number; // bytes of compressed-original retained (recoverable)
    duplicatesCollapsed: number;     // dedup duplicates (original kept on survivor)
    bytesPermanentlyDeleted: number; // ALWAYS 0 — the invariant
  };
  /** Active model/provider (captured live) — shown on the current-repo card. */
  model?: {
    name: string;          // Model.name or Model.id
    provider: string;      // ProviderId (Model.provider)
    providerName: string;  // human display name (e.g. "OpenAI")
    inputRate: number;     // USD per input token (Model.cost)
    outputRate: number;    // USD per output token (Model.cost)
  };
}

export class Dashboard {
  private snapshotPath: string;
  private eventsPath: string;

  constructor(stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    this.snapshotPath = join(stateDir, "dashboard.json");
    this.eventsPath = join(stateDir, "events.log");
  }

  /** Write a full state snapshot (atomically replaces previous). */
  snapshot(data: DashboardSnapshot): void {
    writeFileSync(this.snapshotPath, JSON.stringify(data, null, 2) + "\n");
  }

  /** Append a timestamped JSONL event line. */
  event(type: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
    appendFileSync(this.eventsPath, line + "\n");
  }
}
