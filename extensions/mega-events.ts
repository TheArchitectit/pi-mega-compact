/**
 * mega-events.ts — the pi lifecycle event handlers.
 *
 * Wires every pi event the extension listens for: model/provider capture,
 * session lifecycle + state reset, auto-inline injection, agent/turn tracking,
 * and the auto-trigger compaction pipeline. Keeps the shared MegaRuntime in
 * sync and delegates the heavy lifting to the pipeline + command modules.
 */

import type { ExtensionAPI, ExtensionContext, ContextEvent, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { normalizeSessionId } from "../src/store.js";
import { autoCompactCheck } from "../src/compact.js";
import { estimateSessionTokens } from "../src/tokens.js";
import { dropCompactedRange } from "../src/adapt.js";
import { MegaRuntime, recentUserQuery, WIDGET_KEY } from "./mega-runtime.js";
import { runCompact, doRecall } from "./mega-pipeline.js";
import type { MegaConfig } from "./mega-config.js";

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
        const r = doRecall(runtime, config, ctx, query, "resume");
        if (!r.empty) {
          runtime.pendingRecallBlock = r.block;
          runtime.setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt`);
          runtime.logger.info("auto-inline", { reason: event.reason, query, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
        }
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
      }
    }
    runtime.dashboard.event("session_tree", { sessionId: runtime.rt.sessionId });
    runtime.snapshot(ctx);
  });

  // ---- Auto-inline injection point: prepend staged recall to systemPrompt ----
  pi.on("before_agent_start", async (event, ctx) => {
    runtime.captureModel(ctx); // most reliable point ctx.model is populated
    if (!runtime.pendingRecallBlock) return;
    const block = runtime.pendingRecallBlock;
    runtime.pendingRecallBlock = undefined; // one-shot: consume so we never double-inject
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
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
  });

  // ---- Auto-trigger: fast-gate → confirm → Trident+persist → drop --------
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
    // Prefer the runtime's real token estimate; fall back to our heuristic
    // (and to a percent-of-window proxy when tokens is unknown).
    const currentTokens =
      usage?.tokens ?? estimateSessionTokens(view) ??
      Math.round((pct / 100) * (usage?.contextWindow ?? 0));

    // FAST GATE: token-based (tier threshold), not percentage-based.
    // A 20% gate on a 2M window = 400k, which is way above the 50k low-tier
    // threshold. Gate on the actual token count instead.
    if (currentTokens < config.thresholdTokens) return;

    const check = autoCompactCheck(currentTokens, config.thresholdTokens); // SERVER-STYLE CONFIRM (local)
    if (!check.shouldCompact) return;

    // Debounce so we don't fire on every context event past threshold.
    const now = Date.now();
    if (now < runtime.debounceUntil) return;
    runtime.debounceUntil = now + 2000;

    const ran = runCompact(pi, runtime, config, ctx, messages);
    if (ran.skipped) return;

    // DROP the compacted range from the outgoing context, honoring the anchor
    // floor + tool-pair boundary guards (PREVENT-PI-001/002).
    const kept = dropCompactedRange(messages, ran.keepFrom!, config.anchorUserMessages);
    if (kept.length < messages.length) {
      return { messages: kept };
    }
  });

  // ---- Cancel native compaction once we've persisted our own -------------
  pi.on("session_before_compact", async (_event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    runtime.resetRuntime(ctx.sessionManager.getSessionId());
    if (runtime.rt.persistedThisSession) {
      // We already persisted a checkpoint for this session (via the context
      // hook drop) — cancel pi's own compaction to avoid double-compacting.
      // Our context-hook drop already trimmed the window.
      return { cancel: true };
    }
    // We haven't persisted yet this session: let pi run its native compaction.
    // (Our auto-trigger only fires again past the threshold, and will then
    // capture a checkpoint next time around.)
    return {};
  });
}
