/**
 * recall.ts — unified Layer-5 recall pipeline.
 *
 * `doRecall` is the ONE path that injects (sync). `doRecallAsync` augments with
 * optional cross-repo HNSW on resume / /mega-recall --cross-repo. Both mutate
 * the shared MegaRuntime (token accounting, ticker, dashboard events).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { recallAndInline, recallAndInlineAsync, formatRecallBlock, type RecallInjectResult } from "../../src/recall.js";
import { normalizeSessionId } from "../../src/store.js";
import { incRecallInjected, incCacheHitTokens } from "../../src/store/sqlite.js";
import {
  type MegaRuntime,
  C,
} from "../mega-runtime.js";
import { type MegaConfig } from "../mega-config.js";

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
  // Live window text for inline dedupe (Fix C): drop recalled checkpoints that
  // are already resident in the session, so recall never re-injects context the
  // model can already see. Best-effort — an empty window just skips dedupe.
  const liveWindow = config.windowDedupe ? extractLiveWindow(ctx) : undefined;
  const result = recallAndInline(
    {
      sessionId: sid,
      query,
      limit: config.autoInlineK,
      source,
      skipInjected: true,
      recallMaxTokens: config.recallMaxTokens,
      windowDedupe: config.windowDedupe,
      liveWindow,
      dedupSim: config.dedupSim,
    },
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
  if (result.toInject.length > 0) {
    let sumTokens = 0; for (const h of result.toInject) sumTokens += h.checkpoint.tokenEstimate;
    runtime.rt.recallInjections += result.toInject.length;
    runtime.rt.cacheHitTokens += sumTokens;
    incRecallInjected(result.toInject.length, runtime.currentStateDir);
    incCacheHitTokens(sumTokens, runtime.currentStateDir);
  }
  return result;
}

/**
 * S17: async recall with optional cross-repo augmentation. Used on resume
 * (session_start) and /mega-recall --cross-repo — NEVER from the mid-turn
 * context handler (that stays sync). Runs the sync same-repo scan first; if it
 * returns < config.autoInlineK hits AND crossRepo is enabled, awaits the PGlite
 * HNSW cross-repo path and merges (source-labeled, deduped by checkpointId). The
 * recallMaxTokens cap + windowDedupe apply to the merged set so cross-repo can
 * never net-inflate the window. Cross-repo uses a stricter cosine floor
 * (config.crossRepoCosine) than same-repo. Non-fatal: any async failure returns
 * the same-repo result unchanged.
 */
export async function doRecallAsync(
  runtime: MegaRuntime,
  config: MegaConfig,
  ctx: ExtensionContext,
  query: string,
  source: "resume" | "command",
  opts: { crossRepo?: boolean } = {},
): Promise<RecallInjectResult> {
  runtime.bindRepo(ctx.cwd);
  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
  const liveWindow = config.windowDedupe ? extractLiveWindow(ctx) : undefined;
  // Sync same-repo first (fast, never blocks).
  const sameRepo = recallAndInline(
    {
      sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true,
      recallMaxTokens: config.recallMaxTokens, windowDedupe: config.windowDedupe,
      liveWindow, dedupSim: config.dedupSim,
    },
    runtime.store,
  );
  if (!config.crossRepoEnabled || !opts.crossRepo) return sameRepo;
  if (sameRepo.toInject.length >= config.autoInlineK) return sameRepo; // same-repo satisfied
  // Augment: cross-repo HNSW (async) with the stricter floor. Non-fatal.
  try {
    const x = await recallAndInlineAsync(
      {
        sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true,
        recallMaxTokens: config.recallMaxTokens, windowDedupe: config.windowDedupe,
        liveWindow, dedupSim: config.crossRepoCosine, crossRepo: true,
        globalIndexDir: process.env.MEGACOMPACT_INDEX_DIR,
      },
      runtime.store,
    );
    runtime.dashboard.event("recall-crossrepo", {
      source, query: query.slice(0, 120), injected: x.toInject.length,
      sourceRepos: x.toInject.map((h) => h.repoId).filter(Boolean),
    });
    // Merge, dedup by checkpointId, respect the same token cap by reformatting.
    const seen = new Set(sameRepo.toInject.map((h) => h.checkpoint.checkpointId));
    const merged = [...sameRepo.toInject];
    for (const h of x.toInject) {
      if (!seen.has(h.checkpoint.checkpointId)) { merged.push(h); seen.add(h.checkpoint.checkpointId); }
    }
    const block = merged.length ? formatRecallBlock(merged) : "";
    if (merged.length > 0) {
      let sumTokens = 0; for (const h of merged) sumTokens += h.checkpoint.tokenEstimate;
      runtime.rt.recallInjections += merged.length;
      runtime.rt.cacheHitTokens += sumTokens;
      incRecallInjected(merged.length, runtime.currentStateDir);
      incCacheHitTokens(sumTokens, runtime.currentStateDir);
    }
    return {
      toInject: merged,
      report: merged.map((h) => `  • ${h.checkpoint.checkpointId}${h.repoId ? ` (from ${h.repoId.split("/").filter(Boolean).pop()})` : ""}`),
      block,
      empty: merged.length === 0,
    };
  } catch {
    return sameRepo; // cross-repo failure → same-repo only (non-fatal)
  }
}

/**
 * Extract the live-window message texts from the session manager (Fix C),
 * for inline-dedupe of recalled checkpoints. Best-effort: returns [] on any
 * error so recall falls back to unbounded (still correct, just no dedupe).
 * Mirrors recentUserQuery's use of sessionEntryToContextMessages.
 */
function extractLiveWindow(ctx: ExtensionContext): string[] {
  try {
    const entries = ctx.sessionManager.getEntries();
    const texts: string[] = [];
    for (const e of entries) {
      for (const m of sessionEntryToContextMessages(e)) {
        const c = (m as { content?: unknown }).content;
        if (typeof c === "string") texts.push(c);
        else if (Array.isArray(c)) texts.push(c.map((b: { text?: string }) => b.text ?? "").join(" "));
      }
    }
    return texts;
  } catch {
    return [];
  }
}
