/**
 * dashboard-server/snapshot.ts — snapshot + events.log file readers.
 */

import { readFileSync } from "node:fs";
import type { Snapshot } from "./types.js";

export function readSnapshot(snapshotPath: string) {
  try {
    const raw = readFileSync(snapshotPath, "utf-8");
    return JSON.parse(raw) as Snapshot;
  } catch {
    return {
      version: 1,
      updatedAt: null,
      tier: "unknown",
      presetTier: "unknown",
      pressure: 0,
      config: { fastGatePct: 80, thresholdTokens: 100_000, tierPct: null, effectiveThresholdPct: null, anchorUserMessages: 1, preserveRecent: 2, auto: true, autoInlineK: 3 },
      session: { id: null, state: null, persistedThisSession: false, lastCheckpointId: null, lastCompactedFrom: 0 },
      context: { tokens: null, percent: null, contextWindow: 0 },
      trigger: { armed: false, ready: false, currentTokens: null, thresholdTokens: 100_000, fastGatePct: 80, tierPct: null, effectiveThresholdPct: null },
      store: { checkpointCount: 0, totalTokenEstimate: 0, originalTokens: 0, tokensSaved: 0, injectedCount: 0, dedupHitRate: 0, storageDedupRate: 0, dedupCollapsed: 0 },
      crew: { activeAgents: 0, currentTurn: 0 },
      repo: { checkpointCount: 0, totalTokenEstimate: 0, originalTokens: 0, tokensSaved: 0, sessionCount: 0, dedupAttempts: 0, dedupCollapsed: 0, storageDedupRate: 0 },
      integrity: { regionsRetained: 0, compressedOriginalBytes: 0, duplicatesCollapsed: 0, bytesPermanentlyDeleted: 0 },
      cacheHits: { session: 0, total: 0, sessionTokensSaved: 0, totalTokensSaved: 0 },
      compacts: { session: 0, total: 0 },
      timeSaved: { compact: { sessionSec: 0, totalSec: 0 }, cacheHit: { sessionSec: 0, totalSec: 0 } },
      compression: { session: { tokensIn: 0, tokensOut: 0, tokensFreed: 0, compressionPct: 0, dedupPct: 0 }, repo: { tokensIn: 0, tokensOut: 0, tokensFreed: 0, compressionPct: 0, dedupPct: 0 } },
      model: undefined,
    } as Snapshot;
  }
}

export function readFrom(path: string, charOffset: number): { data: string; offset: number } {
  try {
    const content = readFileSync(path, "utf-8");
    if (content.length <= charOffset) return { data: "", offset: charOffset };
    return { data: content.slice(charOffset), offset: content.length };
  } catch {
    return { data: "", offset: charOffset };
  }
}
