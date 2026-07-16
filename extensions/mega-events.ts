/**
 * mega-events.ts — the pi lifecycle event handlers.
 *
 * Wires every pi event the extension listens for: model/provider capture,
 * session lifecycle + state reset, auto-inline injection, agent/turn tracking,
 * and the auto-trigger compaction pipeline. Keeps the shared MegaRuntime in
 * sync and delegates the heavy lifting to the pipeline + command modules.
 */

import type { ExtensionAPI, ExtensionContext, ContextEvent, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeSessionId } from "../src/store.js";
import { autoCompactCheck } from "../src/compact.js";
import { estimateSessionTokens } from "../src/tokens.js";
import { MegaRuntime, recentUserQuery, WIDGET_KEY } from "./mega-runtime.js";
import { runCompact, doRecall, doRecallAsync, piCompactWouldNoop } from "./mega-pipeline.js";
import { recallMemoriesAndInline } from "../src/recall.js";
import { driveNativeCompaction } from "./mega-compact-driver.js";
import { computeLiveTrimCut, liveTrimSummaryMessage } from "./mega-trim.js";
import { pressureFromPct, type MegaConfig } from "./mega-config.js";

/** Register all pi lifecycle event handlers. */
export function registerEventHandlers(pi: ExtensionAPI, runtime: MegaRuntime, config: MegaConfig): void {
  // ---- Session lifecycle (state reset points) -------------------------------
  // Capture model/provider whenever it changes (drives real cost estimation).
  pi.on("model_select", async (_event, ctx) => {
    runtime.captureModel(ctx);
    runtime.snapshot(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    runtime.resetRuntime(ctx.sessionManager.getSessionId());
    runtime.captureModel(ctx); // best-effort: ctx.model may be set by session start
    runtime.setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
    // S21: clear any stale memory block from a prior session.
    runtime.pendingMemoryRecallBlock = undefined;
    // Auto-inline on resume/fork/continue: stage the most relevant checkpoints
    // so the next before_agent_start prepends them to the system prompt.
    // Triggered whenever this session already has persisted checkpoints AND a
    // usable query — that covers reason "resume"/"fork" (explicit) and
    // reason "startup" (e.g. `pi --continue`s an existing session, which still
    // emits "startup" but with a populated message window). A brand-new empty
    // session has no checkpoints, so it's naturally excluded.
    if (config.autoInline) {
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const query = recentUserQuery(ctx);
      if (query && runtime.store.stats(sid).checkpointCount > 0) {
        // S17: use the async variant on resume so cross-repo HNSW recall can
        // augment when this repo's store is thin. session_start is an async-safe
        // point (unlike the mid-turn context handler, which stays sync).
        const r = await doRecallAsync(runtime, config, ctx, query, "resume", { crossRepo: config.crossRepoEnabled });
        if (!r.empty) {
          runtime.pendingRecallBlock = r.block;
          const crossLabel = r.toInject.some((h) => h.repoId) ? " (cross-repo)" : "";
          runtime.setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt${crossLabel}`);
          runtime.logger.info("auto-inline", { reason: event.reason, query, injected: r.toInject.map((h) => h.checkpoint.checkpointId), crossRepo: r.toInject.some((h) => h.repoId) });
        }
      }
      // S21: parallel memory recall. Same async context so we can await without
      // breaking the handler contract. Best-effort — never throws.
      try {
        const mr = await recallMemoriesAndInline({
          query, stateDir: runtime.getStateDir(), limit: 5,
        });
        if (!mr.empty) runtime.pendingMemoryRecallBlock = mr.block;
      } catch (err) {
        runtime.logger.warn("memory-recall skipped", { err: String(err) });
      }
    }
    runtime.dashboard.event("session_start", { reason: event.reason, sessionId: runtime.rt.sessionId });
    runtime.snapshot(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    // Branch navigation invalidates region indexes — reset checkpoint memory but
    // keep the on-disk store (markers replayed from entries below if needed).
    runtime.resetRuntime(ctx.sessionManager.getSessionId());
    runtime.setStatus(ctx, "mega-compact: ready (branch)");
    if (config.autoInline) {
      const query = recentUserQuery(ctx);
      if (query) {
        const r = doRecall(runtime, config, ctx, query, "resume");
        if (!r.empty) {
          runtime.pendingRecallBlock = r.block;
          runtime.logger.info("auto-inline", { reason: "session_tree", query, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
        }
        // S21: parallel memory recall. Trigram embedder is sub-ms; await is fine.
        try {
          const mr = await recallMemoriesAndInline({ query, stateDir: runtime.getStateDir(), limit: 5 });
          if (!mr.empty) runtime.pendingMemoryRecallBlock = mr.block;
        } catch (err) {
          runtime.logger.warn("memory-recall skipped", { err: String(err) });
        }
      }
    }
    runtime.dashboard.event("session_tree", { sessionId: runtime.rt.sessionId });
    runtime.snapshot(ctx);
  });

  // ---- Auto-inline injection point: prepend staged recall to systemPrompt ----
  pi.on("before_agent_start", async (event, ctx) => {
    runtime.captureModel(ctx); // most reliable point ctx.model is populated
    const cpBlock = runtime.pendingRecallBlock;
    const memBlock = runtime.pendingMemoryRecallBlock;
    if (!cpBlock && !memBlock) return;
    runtime.pendingRecallBlock = undefined;
    runtime.pendingMemoryRecallBlock = undefined;
    const composed = [cpBlock, memBlock].filter(Boolean).join("\n\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${composed}` };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    runtime.setStatus(ctx, undefined);
    runtime.activeAgents = 0;
    runtime.currentTurn = 0;
    ctx.ui.setWidget(WIDGET_KEY, [], { placement: "aboveEditor" });
  });

  // ---- Agent tracking for real-time widget + status-line updates ---------
  pi.on("agent_start", async (_event, ctx) => {
    runtime.activeAgents++;
    runtime.dashboard.event("agent_start", { activeAgents: runtime.activeAgents });
    // Surface live agent activity on the status line (toolbar), not just the
    // above-editor widget — otherwise concurrent agents look frozen.
    runtime.setStatus(ctx, `mega-compact: ▶ ${runtime.activeAgents} agent${runtime.activeAgents === 1 ? "" : "s"}`);
    runtime.snapshot(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    runtime.activeAgents = Math.max(0, runtime.activeAgents - 1);
    runtime.dashboard.event("agent_end", { activeAgents: runtime.activeAgents });
    if (runtime.activeAgents > 0) {
      runtime.setStatus(ctx, `mega-compact: ▶ ${runtime.activeAgents} agent${runtime.activeAgents === 1 ? "" : "s"}`);
    } else {
      runtime.setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
    }
    // S16 continuation fallback: if the turn settled idle right after a live-trim
    // compaction AND there is queued work AND we haven't nudged recently, nudge
    // once so the agent continues (the live trim should make this rare). Guarded
    // to never busy-loop: one nudge per 30s, only when truly idle + queued.
    if (config.auto && runtime.activeAgents === 0) {
      try {
        const idle = ctx.isIdle?.() ?? true;
        const queued = ctx.hasPendingMessages?.() ?? false;
        const now = Date.now();
        if (idle && queued && now >= runtime.resumeNudgeUntil) {
          runtime.resumeNudgeUntil = now + 30_000;
          pi.sendUserMessage("[mega-compact] continue from the compacted context above.");
        }
      } catch {
        /* non-fatal: a failed nudge never blocks */
      }
    }
    runtime.snapshot(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    runtime.currentTurn = event.turnIndex;
    runtime.dashboard.event("turn_start", { turnIndex: event.turnIndex });
    runtime.snapshot(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    runtime.dashboard.event("turn_end", { turnIndex: event.turnIndex });
    runtime.snapshot(ctx);

    // S20: auto-review the conversation every N turns and persist durable
    // memories. Best-effort + non-fatal: a review failure must never break the
    // agent loop. Debounced by memoryReviewInterval turns.
    if (config.memoryAutoReview && runtime.currentTurn > 0 && runtime.currentTurn % config.memoryReviewInterval === 0) {
      try {
        const { reviewConversation } = await import("../src/memory.js");
        const { applyMemoryOps } = await import("../src/memoryOps.js");
        const entries = ctx.sessionManager.getEntries();
        const view = runtime.engineView(entries.flatMap((e: any) => (e.message ? [e.message] : [])));
        const ops = reviewConversation(view, []);
        if (ops.length) await applyMemoryOps(ops, runtime.currentStateDir);
      } catch {
        /* non-fatal — auto-review must not break the turn loop */
      }
    }
  });

  // ---- Auto-trigger: live trim (compact and continue) + native durable ----
  // S16 redesign: we NO LONGER call ctx.compact() from the auto-trigger by
  // default. That mapped to pi's MANUAL compaction path, which abort()s the
  // in-flight turn (agent-session.js:1345) and stops the agent. Instead:
  //  - LIVE: return { messages: trimmedView } from the context event. This
  //    feeds pi's transformContext (sdk.js:226 → agent-loop.js:180) so the
  //    model sees a compacted window EVERY LLM call, with no abort. The turn
  //    continues. We persist our recall checkpoint (the durable value) first.
  //  - DURABLE: pi's NATIVE auto-compaction fires at agent-end
  //    (agent-session.js:1565), continues (return hasQueuedMessages()), and
  //    emits session_before_compact — where OUR driveNativeCompaction supplies
  //    the summary and pi truncates the transcript on disk. No ctx.compact().
  // Legacy: MEGACOMPACT_LEGACY_DURABLE_TRIM=true restores the v0.4.28 ctx.compact
  // path (kept one release as rollback).
  pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    if (!config.auto) return;
    const usage = ctx.getContextUsage();
    const pct = usage?.percent;
    // Always track context for the dashboard, even if we return early below.
    runtime.lastCtxTokens = usage?.tokens ?? null;
    runtime.lastCtxPercent = pct ?? null;
    runtime.lastCtxWindow = usage?.contextWindow ?? 0;
    runtime.snapshot(ctx);
    if (pct == null) return;

    const messages = event.messages;
    const view = runtime.engineView(messages);
    const currentTokens =
      usage?.tokens ?? estimateSessionTokens(view) ??
      Math.round((pct / 100) * (usage?.contextWindow ?? 0));

    // FAST GATE: token-based (tier threshold), not percentage-based.
    if (currentTokens < config.thresholdTokens) return;

    const check = autoCompactCheck(currentTokens, config.thresholdTokens); // SERVER-STYLE CONFIRM (local)
    if (!check.shouldCompact) return;

    // Debounce so we don't fire on every context event past threshold.
    const now = Date.now();
    if (now < runtime.debounceUntil) return;
    runtime.debounceUntil = now + 2000;

    // Adaptive compression (Fix E): scale compression strength + keepFrom depth
    // with how close we are to the model context limit.
    const pressure = pressureFromPct(pct);
    const ran = runCompact(pi, runtime, config, ctx, messages, { compressionPressure: pressure });
    if (ran.skipped) return;

    // LEGACY path (rollback): v0.4.28 ctx.compact() + the no-op gate. The
    // manual compact path aborts the in-flight turn — only used behind the flag.
    // Read live from env (in addition to the load-time config) so the flag can be
    // toggled per-test without reloading the module; config.legacyDurableTrim is
    // the cached default. (Mirrors how piCompactWouldNoop re-reads its floor.)
    const legacy = config.legacyDurableTrim || process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM === "true" || process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM === "1";
    if (legacy) {
      if (piCompactWouldNoop(ctx)) return;
      ctx.compact({ customInstructions: undefined });
      return;
    }

    // S16 LIVE trim: collapse the compacted region to a summary + recent anchor.
    // Non-destructive: pi keeps the real transcript; only this LLM call sees the
    // trimmed window. We compute the cut on the engine view (pure, tested) then
    // slice the ORIGINAL pi AgentMessage[] from that index (lossless alignment,
    // mirroring dropCompactedRange) and prepend a user-role summary message.
    // A build failure or unsafe cut returns nothing (no trim this call — the
    // next context event retries). The anchor floor is read live from env (the
    // config value is the cached default) so it can be tuned per-test / per-run
    // without reloading the module.
    try {
      const anchorEnv = process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
      const anchorUserMessages = (anchorEnv != null && anchorEnv !== "" && Number.isFinite(Number(anchorEnv)))
        ? Number(anchorEnv)
        : config.anchorUserMessages;
      const cut = computeLiveTrimCut(view, {
        compactedFrom: ran.result.compactedFrom,
        summary: ran.result.summary,
        anchorUserMessages,
      });
      if (cut === null) return; // unsafe / below anchor floor — no trim this call
      const summaryMsg = liveTrimSummaryMessage({
        compactedFrom: ran.result.compactedFrom,
        summary: ran.result.summary,
        anchorUserMessages: config.anchorUserMessages,
      });
      // Synthesize a user-role AgentMessage carrying the compacted summary.
      const summaryAgentMsg = {
        role: "user" as const,
        content: summaryMsg.text,
        timestamp: Date.now(),
      } as unknown as AgentMessage;
      const recent = messages.slice(cut); // guardrails-allow PREVENT-PI-002: `cut` is the pre-sanitized `compactedFrom` produced by src/boundary.ts computeDropRange, so the preserved run begins on a toolPair-safe index.
      runtime.snapshot(ctx);
      return { messages: [summaryAgentMsg, ...recent] };
    } catch {
      return; // non-fatal: no trim this call; the next context event retries
    }
  });

  // ---- Supply a DURABLE trim to pi's native compaction (Fix B) ----------
  // We run the Trident pipeline to produce a compressed summary, then return
  // it as a CompactionResult. pi writes the summary into a compactionSummary
  // entry AND truncates the on-disk transcript from firstKeptEntryId. This is
  // the durable fix for "tokens grow on read": the trim survives resume, so
  // there is no full-reload + additive recall inflation.
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    runtime.resetRuntime(ctx.sessionManager.getSessionId());
    if (!config.auto) return {}; // let pi run its own native compaction
    try {
      const result = driveNativeCompaction(event, runtime, config);
      if (result) {
        runtime.logger.info("native-compact", {
          sessionId: runtime.rt.sessionId,
          firstKeptEntryId: result.compaction.firstKeptEntryId,
          tokensBefore: result.compaction.tokensBefore,
          summaryTokens: result.compaction.estimatedTokensAfter,
        });
        return { compaction: result.compaction };
      }
    } catch (err) {
      runtime.logger.error("native-compact-failed", {
        sessionId: runtime.rt.sessionId,
        error: String(err instanceof Error ? err.message : err),
      });
    }
    // Fall back to pi's own native compaction if we can't supply one.
    return {};
  });
}
