/**
 * compact.ts — full compaction pipeline (Trident) + pi no-op prediction.
 *
 * `runCompact` runs the full Trident pipeline (fast-gate aside) and persists a
 * checkpoint. `piCompactWouldNoop` predicts whether pi's `ctx.compact()` would
 * throw a no-op error. Both mutate the shared MegaRuntime (token accounting,
 * ticker, status, events) and are driven by the event + command handlers in
 * mega-events.ts / mega-commands.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactSession } from "../../src/engine.js";
import type { EngineMessage } from "../../src/types.js";
import { normalizeSessionId } from "../../src/store.js";
import { estimateBlockTokens } from "../../src/tokens.js";
import { touchSession, logDaily, incCompactCount, incCacheHitTokens } from "../../src/store/sqlite.js";
import { consolidateMemories } from "../../src/memory.js";
import {
  type MegaRuntime,
  C,
  MARKER_TYPE,
} from "../mega-runtime.js";
import { resolveRepoRoot, preserveRecentForPressure, type MegaConfig } from "../mega-config.js";
import { runRaptor } from "../../src/dedup/raptor/index.js";
import { loadDedupConfig } from "../../src/config/dedup.js";
import { upsertEmbedding as indexUpsertEmbedding } from "../../src/store/vectorIndex.js";
import { runMemoryReview } from "./memory-review.js";

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
  opts: { keepFrom?: number; summary?: string; compressionPressure?: number } = {},
): RunCompactResult {
  runtime.bindRepo(ctx.cwd);
  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
  runtime.resetRuntime(sid);
  runtime.rt.sessionId = sid;

  const view = runtime.engineView(messages);
  // keepFrom deepens with context pressure (Fix E): under high pressure we
  // compact more of the session, down to the preserveRecentMin floor.
  const preserve = preserveRecentForPressure(
    opts.compressionPressure ?? 0,
    config.preserveRecent,
    config.preserveRecentMin,
  );
  const keepFrom = opts.keepFrom ?? Math.max(0, view.length - preserve);
  // For very small sessions (fewer messages than preserveRecent), allow
  // compacting everything except the last message — the user explicitly
  // requested compaction, so don't refuse it just because the session is short.
  if (keepFrom <= 0) {
    if (view.length <= 1) return { skipped: true };
    // Use the fallback: compact everything except the last message
    const fallbackKeepFrom = view.length - 1;
    return doCompact(view, fallbackKeepFrom, opts, sid, config, pi, ctx, runtime);
  }

  return doCompact(view, keepFrom, opts, sid, config, pi, ctx, runtime);
}

function doCompact(
  view: EngineMessage[],
  keepFrom: number,
  opts: { keepFrom?: number; summary?: string; compressionPressure?: number },
  sid: string,
  config: MegaConfig,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: MegaRuntime,
): RunCompactResult {
  runtime.pulsing = true; // animate the status line while the (sync) pipeline runs
  runtime.setEffect?.("pulse", "accent", 1500); // v0.8.3: ambient border pulse during compaction
  // S21.2: reset the per-compaction memory-op counter so the post-compact
  // consolidate pass only fires when memory rows actually changed during the
  // compaction window (turn_end → auto-review may have written some).
  runtime.memoriesTouchedThisCompaction = 0;
  const result = compactSession(
    {
      sessionId: sid,
      messages: view,
      keepFrom,
      summary: opts.summary,
      timestamp: Date.now(),
      onTier: runtime.makeTierCallback(ctx),
      compressionPressure: opts.compressionPressure,
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
  runtime.rt.compactCount += 1;
  incCompactCount(runtime.currentStateDir);
  if (result.deduped) { runtime.rt.cacheHitTokens += saved; incCacheHitTokens(saved, runtime.currentStateDir); }
  runtime.rt.lastCompactAt = Date.now();
  if (result.deduped) runtime.rt.dedupSkips++;
  // Grow the rolling "saved" goal so the progress bar always has a fresh
  // denominator (we don't want it pinned at 100% once we pass an old target).
  if (runtime.rt.tokensSaved > runtime.savedGoal) runtime.savedGoal = Math.ceil((runtime.rt.tokensSaved * 1.25) / 10_000) * 10_000;

  // Live toolbar activity: what file/region just got compacted or deduped.
  // Rendered via the rotating ticker line (see snapshot); the ring buffer is
  // cycled one-per-repaint so the single line scrolls through recent files.
  const files = result.filesModified ?? [];
  const fileLabel = files.length
    ? files.map((f) => f.split("/").pop() ?? f).slice(0, 2).join(", ")
    : result.regionHash.slice(0, 8);
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

  // S21.2: best-effort consolidation of near-duplicate memories for this repo.
  // Runs after the per-repo stats touch so `consolidateMemories` can use the
  // same stateDir. Non-fatal — a failed consolidate never blocks a compaction.
  // Only runs when new memory ops landed in this pass (otherwise the prior
  // compaction's consolidate already had its shot — re-running would just
  // touch every row again with no merges).
  if (!result.deduped && runtime.memoriesTouchedThisCompaction > 0) {
    try {
      const root = resolveRepoRoot(ctx.cwd);
      void consolidateMemories(runtime.currentStateDir, root).then(
        (n) => {
          if (n > 0) runtime.pushTicker(`${C.green}∫${C.reset} consolidated ${n} memory dup${n === 1 ? "" : "s"}`);
        },
        () => {
          /* swallow: consolidate failures must never surface to the user */
        },
      );
    } catch {
      /* non-fatal */
    }
  }

  // S24 review-on-compact: when pressure is high, the just-compacted region is
  // exactly the context worth remembering, so review it immediately rather than
  // waiting for the next turn-cadence tick. Uses the shared runMemoryReview
  // helper (fire-and-forget; doCompact is sync). Best-effort + non-fatal. Only
  // fires above the `high` band so low-pressure compactions don't pay the cost.
  if (!result.deduped && config.memoryAutoReview && runtime.pressureBand !== "low" && runtime.pressureBand !== "medium") {
    void runMemoryReview(runtime, view, "pressure");
  }

  // Sentinel marker: a non-LLM bookkeeping entry so subsequent triggers can
  // skip re-vectorizing an already-compacted region (zero token cost).
  pi.appendEntry(MARKER_TYPE, {
    checkpointId: result.checkpointId,
    regionHash: result.regionHash,
    tokenEstimate: result.tokenEstimate,
    deduped: result.deduped,
  });

  // Fix D: refresh the RAPTOR tree for this session so live recall (search) can
  // serve high-level summaries. Best-effort + non-fatal: never block compaction.
  // Budget-guarded (RAPTOR_BUDGET_MS) so it can't hang a large session.
  if (config.raptorEnabled && !result.deduped) {
    try {
      const dd = loadDedupConfig();
      const all = runtime.store.list(sid);
      const leaves = all.map((cp) => ({
        id: cp.checkpointId,
        messages: [],
        sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
        embedding: cp.embedding,
      }));
      if (leaves.length >= 2) {
        // S25: stamp the tree with the newest checkpoint epoch so the
        // freshness guard in raptorSearchHits can reject stale trees after a
        // later compaction adds newer checkpoints.
        const builtAt = all.length > 0 ? Math.max(...all.map((c) => c.timestamp)) : Date.now();
        runRaptor(
          leaves,
          {
            stateDir: runtime.currentStateDir,
            sessionId: sid,
            budgetMs: dd.RAPTOR_BUDGET_MS,
            clustersPerLevel: dd.RAPTOR_CLUSTERS_PER_LEVEL,
            consistencyThreshold: dd.RAPTOR_CONSISTENCY,
            logger: runtime.logger,
            builtAt: Number.isFinite(builtAt) ? builtAt : Date.now(),
          },
        );
      }
    } catch {
      /* non-fatal: tree refresh never blocks a compaction */
    }
  }

  // Slice 2: best-effort mirror of the new checkpoint into the async global
  // PGlite/HNSW vector index. Fires once per compaction (not per-add), so the
  // shared global dir is never hammered by concurrent test workers.
  // Non-fatal: a WASM init failure degrades to the sync scan silently.
  if (!result.deduped) {
    try {
      const all = runtime.store.list(sid);
      const latest = all.find((cp) => cp.checkpointId === result.checkpointId);
      if (latest?.embedding) {
        void indexUpsertEmbedding(
          runtime.currentStateDir,
          sid,
          latest.checkpointId,
          latest.embedding,
        ).catch(() => {
          /* non-fatal: index refresh never blocks a compaction */
        });
      }
    } catch {
      /* non-fatal: index refresh never blocks a compaction */
    }
  }

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
 * Predict whether pi's `ctx.compact()` would throw a no-op error — "Already
 * compacted" or "Nothing to compact (session too small)" — so the auto-trigger
 * can SKIP the call instead of surfacing a hard, user-facing error.
 *
 * Why we can't intercept or suppress it: pi's public `compact()` computes
 * `prepareCompaction()` and throws *before* it emits `session_before_compact`,
 * so our handler there never runs on the no-op path. And `ctx.compact()`'s
 * `onError` callback fires only AFTER pi has already emitted a `compaction_end`
 * event carrying the error message (which the interactive UI renders) — so
 * `onError` cannot mute it either. The only robust fix is to not call
 * `ctx.compact()` when pi would no-op. (pi's own `_runAutoCompaction` path is
 * silent on this same condition; the public path we're forced through is the
 * one that throws.)
 *
 * Skipping is correct, not a compromise: by the time this runs, `runCompact()`
 * has already persisted the recall checkpoint (Path A). The durable on-disk
 * trim is only useful when pi can actually summarize a region; a transcript
 * under pi's `keepRecentTokens` budget is small enough that reloading it on
 * resume isn't a token-growth problem, so the durable trim is unnecessary
 * there anyway.
 *
 * Mirrors pi's `prepareCompaction()` return-undefined conditions (compaction.js):
 *  (1) last entry is a compaction      → "Already compacted"
 *  (2) <2 cut-point messages since the last compaction → nothing to summarize
 *      (a cut point = any non-toolResult message — user/assistant/bash/custom/
 *       branchSummary/compactionSummary — matching pi's isCutPointMessage)
 *  (3) transcript tokens since the last compaction < keepRecentTokens → pi
 *      keeps everything → nothing to summarize
 * `keepRecentTokens` isn't readable from the extension API, so (3) uses the pi
 * default (20000) as a conservative floor; raise it via
 * `MEGACOMPACT_DURABLE_TRIM_FLOOR` if you raise pi's `compact.keepRecentTokens`.
 *
 * Best-effort: on any read error returns true (skip) — skipping a durable trim
 * is always safe; calling `ctx.compact()` on a no-op throws to the user.
 */
export function piCompactWouldNoop(ctx: ExtensionContext): boolean {
  try {
    const branch = ctx.sessionManager.getBranch();
    if (branch.length === 0) return true;
    // (1) already compacted — pi throws "Already compacted"
    if (branch[branch.length - 1].type === "compaction") return true;
    // boundaryStart = index just after the most recent compaction entry (or 0)
    let boundaryStart = 0;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "compaction") { boundaryStart = i + 1; break; }
    }
    let cutPoints = 0;
    let tokens = 0;
    for (let i = boundaryStart; i < branch.length; i++) {
      const e = branch[i];
      if (e.type === "compaction") continue;
      let isCut = false;
      for (const m of sessionEntryToContextMessages(e)) {
        // pi's isCutPointMessage: every role except toolResult
        if ((m as { role?: string }).role !== "toolResult") isCut = true;
        const c = (m as { content?: unknown }).content;
        const text =
          typeof c === "string" ? c
          : Array.isArray(c)
            ? (c as { text?: string }[]).map((b) => b?.text ?? "").join(" ")
            : "";
        if (text) tokens += estimateBlockTokens(text);
      }
      if (isCut) cutPoints++;
    }
    // (2) need >=2 cut points so the kept cut isn't the first message
    if (cutPoints < 2) return true;
    // (3) transcript under pi's keepRecentTokens budget → pi keeps everything
    if (tokens < durableTrimFloorTokens()) return true;
    return false;
  } catch {
    return true; // safe: skip the durable trim rather than risk a user-facing throw
  }
}

/** pi's default keepRecentTokens (compaction settings). Override with
 *  MEGACOMPACT_DURABLE_TRIM_FLOOR if you raise pi's compact.keepRecentTokens. */
function durableTrimFloorTokens(): number {
  const raw = process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
  if (raw !== undefined && Number.isFinite(Number(raw))) return Number(raw);
  return 20_000;
}
