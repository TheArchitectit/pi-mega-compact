/**
 * mega-compact-driver.ts — the durable-trim driver (Fix B).
 *
 * The read-path token-growth bug: the old design cancelled pi's native
 * compaction (`{ cancel: true }`) and did its own ephemeral `context`-hook
 * drop. That drop only affected the outgoing request — the on-disk transcript
 * was never trimmed (the session manager is read-only for extensions). So on
 * resume pi reloaded the FULL transcript and we ADDED a recall block on top →
 * more tokens than before compaction.
 *
 * The fix: on `session_before_compact` we RUN the Trident pipeline to produce a
 * genuinely compressed summary, then RETURN it as a `CompactionResult`. pi
 * durably writes our summary into a `compactionSummary` entry AND truncates the
 * transcript from `firstKeptEntryId`. After that, resume reloads the already-
 * trimmed transcript (summary baked in) — no additive re-injection, no token
 * growth.
 *
 * We reuse pi's `preparation.firstKeptEntryId` (pi already computed the cut
 * honoring the anchor-floor + tool-pair guards — PREVENT-PI-002) rather than
 * recomputing it, so we cannot hand pi a boundary that splits a tool pair.
 */

import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactSession } from "../src/engine.js";
import { toEngineMessages } from "../src/adapt.js";
import { estimateBlockTokens, estimateSessionTokens } from "../src/tokens.js";
import type { MegaRuntime } from "./mega-runtime.js";
import type { MegaConfig } from "./mega-config.js";
import { recallRaptorRootSummary } from "../src/dedup/raptor/index.js";

export interface NativeCompactionResult {
  /** Our trimmed summary + the pi entry to keep from (durable trim). */
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter: number;
  };
}

/**
 * Build our durable compaction result from pi's pre-computed preparation.
 *
 * Returns undefined when there is nothing to summarize (pi will then run its
 * own native compaction, or skip). Never throws for "empty" — best-effort.
 */
export function driveNativeCompaction(
  event: SessionBeforeCompactEvent,
  runtime: MegaRuntime,
  config: MegaConfig,
): NativeCompactionResult | undefined {
  const prep = event.preparation;
  if (!prep) return undefined;

  const sid = runtime.rt.sessionId;
  const messagesToSummarize: AgentMessage[] = prep.messagesToSummarize ?? [];
  if (messagesToSummarize.length === 0) return undefined;

  const engineView = toEngineMessages(messagesToSummarize);
  // We don't drop anything here — pi keeps from prep.firstKeptEntryId. We only
  // summarize the region pi is about to discard.
  const keepFrom = engineView.length;

  const result = compactSession(
    {
      sessionId: sid,
      messages: engineView,
      keepFrom,
      timestamp: Date.now(),
      useExtractiveSummary: true,
    },
    runtime.store,
  );
  if (result.skipped) return undefined;

  // Prefer the RAPTOR root summary when the tree is built + enabled (Fix D):
  // it is a session-level compressed summary, broader than one slice's. Fall
  // back to the extractive topicSummary of this slice.
  let summary = result.summary;
  if (config.raptorEnabled) {
    const root = recallRaptorRootSummary(sid, runtime.currentStateDir);
    if (root) summary = root;
  }

  const tokensBefore = prep.tokensBefore ?? estimateSessionTokens(engineView);
  const summaryTokens = estimateBlockTokens(summary);
  // pi keeps the tail from firstKeptEntryId; our summary replaces the discarded
  // region. Honest saved = discarded-region tokens − our summary tokens.
  const savedTokens = Math.max(0, tokensBefore - summaryTokens);

  runtime.rt.lastCompactedFrom = keepFrom;
  runtime.rt.lastCompactedTokens = tokensBefore;
  runtime.rt.tokensSaved += savedTokens;
  runtime.rt.lastCompactAt = Date.now();
  runtime.rt.persistedThisSession = true;

  return {
    compaction: {
      summary,
      firstKeptEntryId: prep.firstKeptEntryId,
      tokensBefore,
      estimatedTokensAfter: summaryTokens,
    },
  };
}
