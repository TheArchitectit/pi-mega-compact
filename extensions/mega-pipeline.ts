/**
 * mega-pipeline.ts — the compaction + recall pipelines.
 *
 * `runCompact` runs the full Trident pipeline (fast-gate aside) and persists a
 * checkpoint. `doRecall` is the unified Layer-5 recall entry point. Both mutate
 * the shared MegaRuntime (token accounting, ticker, status, events) and are
 * driven by the event + command handlers in mega-events.ts / mega-commands.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactSession } from "../src/engine.js";
import { recallAndInline } from "../src/recall.js";
import { normalizeSessionId } from "../src/store.js";
import { touchSession, logDaily } from "../src/store/sqlite.js";
import {
  MegaRuntime,
  C,
  MARKER_TYPE,
} from "./mega-runtime.js";
import { resolveRepoRoot, type MegaConfig } from "./mega-config.js";

export type RunCompactResult =
  | { skipped: true }
  | { skipped: false; result: ReturnType<typeof compactSession>; keepFrom: number; saved: number };

/** Run the full compaction pipeline and persist a checkpoint. Returns the result. */
export function runCompact(
  pi: ExtensionAPI,
  runtime: MegaRuntime,
  config: MegaConfig,
  ctx: ExtensionContext,
  messages: AgentMessage[],
  opts: { keepFrom?: number; summary?: string } = {},
): RunCompactResult {
  runtime.bindRepo(ctx.cwd);
  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
  runtime.resetRuntime(sid);
  runtime.rt.sessionId = sid;

  const view = runtime.engineView(messages);
  const keepFrom = opts.keepFrom ?? Math.max(0, view.length - config.preserveRecent);
  if (keepFrom <= 0) return { skipped: true };

  runtime.pulsing = true; // animate the status line while the (sync) pipeline runs
  const result = compactSession(
    {
      sessionId: sid,
      messages: view,
      keepFrom,
      summary: opts.summary,
      timestamp: Date.now(),
      onTier: runtime.makeTierCallback(ctx),
    },
    runtime.store,
  );
  runtime.pulsing = false;

  if (result.skipped) return { skipped: true };
  if (!result.deduped) {
    runtime.rt.persistedThisSession = true;
    runtime.rt.lastCheckpointId = result.checkpointId;
  }
  runtime.rt.lastCompactedFrom = result.compactedFrom;
  runtime.rt.lastCompactedTokens = result.tokenEstimate;
  runtime.rt.dedupAttempts++;
  // Honest "tokens saved" for this session-instance only:
  //   new checkpoint      → original − stored
  //   deduped onto existing → whole original region (nothing new stored)
  // Resets to 0 on session_start (rt is rebuilt) — so a fresh session shows 0
  // while the repo's cumulative saved (SQLite meta) keeps the running total.
  const saved = result.deduped
    ? result.originalTokenEstimate
    : Math.max(0, result.originalTokenEstimate - result.tokenEstimate);
  runtime.rt.tokensSaved += saved;
  if (result.deduped) runtime.rt.dedupSkips++;
  // Grow the rolling "saved" goal so the progress bar always has a fresh
  // denominator (we don't want it pinned at 100% once we pass an old target).
  if (runtime.rt.tokensSaved > runtime.savedGoal) runtime.savedGoal = Math.ceil((runtime.rt.tokensSaved * 1.25) / 10_000) * 10_000;

  // Live toolbar "now processing" line: what file/region just got compacted or
  // deduped. Reset to the last-seen action after a few seconds (see snapshot).
  const files = result.filesModified ?? [];
  const fileLabel = files.length
    ? files.map((f) => f.split("/").pop() ?? f).slice(0, 2).join(", ")
    : result.regionHash.slice(0, 8);
  runtime.currentActivity = result.deduped
    ? `♻ deduped ${fileLabel}`
    : `🗜 compacted ${result.checkpointId} · ${fileLabel}`;
  runtime.lastActivityAt = Date.now();
  // Explain-why line: surfaced while fresh. Pulls the dedup reason (which for
  // L2 includes the cosine sim) so the user sees WHY a region was kept/dropped.
  runtime.lastWhy = result.deduped
    ? `why: deduped@${result.dedupReason ?? "tier"}`
    : `why: compacted → ${result.checkpointId}`;
  // Recall/activity ticker: record this event in the ring buffer.
  const savedK = (saved / 1000).toFixed(1);
  runtime.pushTicker(
    result.deduped
      ? `${C.green}♻${C.reset} deduped ${fileLabel} · ${savedK}k saved`
      : `${C.cyan}🗜${C.reset} ${result.checkpointId} · +${savedK}k · ${fileLabel}`,
  );
  // The per-tier trace has settled into the final outcome — fold it back into
  // the activity line and stop showing the live trace.
  runtime.tierTrace = undefined;

  // Record session activity + a daily-log entry in the per-repo SQLite store
  // (foundation for resume-sessions / daily-log features). Best-effort — never
  // block a compaction on bookkeeping.
  try {
    const root = resolveRepoRoot(ctx.cwd);
    touchSession(sid, root, runtime.currentStateDir);
    logDaily(sid, "compact", result.checkpointId, saved, runtime.currentStateDir);
  } catch {
    /* non-fatal: stats bookkeeping only */
  }

  // Sentinel marker: a non-LLM bookkeeping entry so subsequent triggers can
  // skip re-vectorizing an already-compacted region (zero token cost).
  pi.appendEntry(MARKER_TYPE, {
    checkpointId: result.checkpointId,
    regionHash: result.regionHash,
    tokenEstimate: result.tokenEstimate,
    deduped: result.deduped,
  });

  runtime.setStatus(
    ctx,
    runtime.rt.persistedThisSession
      ? `mega-compact: ${result.checkpointId} · ${saved} tok saved`
      : `mega-compact: ready`,
  );
  runtime.logger.info("compact", {
    sessionId: sid,
    checkpointId: result.checkpointId ?? "(deduped)",
    deduped: result.deduped,
    tokenEstimate: saved,
    compactedFrom: result.compactedFrom,
  });
  runtime.dashboard.event("compact", {
    sessionId: sid,
    checkpointId: result.checkpointId ?? "(deduped)",
    deduped: result.deduped,
    tokenEstimate: saved,
    compactedFrom: result.compactedFrom,
  });
  runtime.snapshot(ctx);
  return { skipped: false, result, keepFrom, saved };
}

/**
 * Unified recall (Layer 5). The ONE path that injects. Returns the recall
 * result; callers decide whether to stage it for before_agent_start (resume)
 * or report it (command).
 */
export function doRecall(
  runtime: MegaRuntime,
  config: MegaConfig,
  ctx: ExtensionContext,
  query: string,
  source: "resume" | "command",
) {
  runtime.bindRepo(ctx.cwd);
  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
  const result = recallAndInline(
    { sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true },
    runtime.store,
  );
  runtime.dashboard.event("recall", { source, query: query.slice(0, 120), injected: result.toInject.length, empty: result.empty });
  if (!result.empty && result.toInject.length > 0) {
    const top = result.toInject[0];
    const scorePct = Math.round((top.score ?? 0) * 100);
    const files = top.checkpoint.filesModified ?? [];
    const label = files.length ? files.map((f) => f.split("/").pop() ?? f).slice(0, 2).join(", ") : top.checkpoint.checkpointId;
    runtime.pushTicker(`${C.amber}↩${C.reset} recalled ${top.checkpoint.checkpointId} · ${scorePct}% · ${label}`);
    runtime.lastWhy = `why: recalled@${scorePct}% (${result.toInject.length} chkpt)`;
  }
  return result;
}
