/**
 * pi-mega-compact — layered, local, vector-backed context compressor.
 *
 * Extension entry. Wires the pi-agnostic Trident engine (src/) into pi's
 * extension lifecycle.
 *
 * Design constraints (from RESEARCH.md):
 *  - No network at runtime (PREVENT-PI-004).
 *  - pi Message has no system-role entry (PREVENT-PI-003); inject compacted
 *    context via `before_agent_start` systemPrompt (Sprint 4), or a
 *    `compactionSummary` message so it renders like native compaction.
 *  - Message drops must preserve an anchor floor (PREVENT-PI-001) and never
 *    split a toolCall/toolResult pair (PREVENT-PI-002).
 *
 * Sprint 3 wires: config, session state reset, the auto-trigger pipeline
 * (fast-gate → auto_compact_check → Trident+persist → context drop),
 * session_before_compact cancellation, the compact-marker sentinel, and the
 * /megacompact + /megacompact-status commands.
 *
 * Sprint 4 wires the unified recall layer (Layer 5): recallAndInline() is the
 * ONLY code path that injects compacted context. It serves three entry points —
 * auto-inline on resume/branch (before_agent_start), on-demand /recall-context,
 * and the dedup sentinel — all through one dedup engine, injected via the
 * before_agent_start systemPrompt prepend (PREVENT-PI-003).
 */

import type { ExtensionAPI, ExtensionContext, ContextEvent, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { STATE_DIR_DEFAULT } from "../src/config.js";
import { VectorStore } from "../src/vectorStore.js";
import { toEngineMessages, dropCompactedRange } from "../src/adapt.js";
import { compactSession } from "../src/engine.js";
import { recallAndInline } from "../src/recall.js";
import { autoCompactCheck } from "../src/compact.js";
import { estimateSessionTokens } from "../src/tokens.js";
import { normalizeSessionId } from "../src/store.js";
import type { EngineMessage } from "../src/types.js";

const STATUS_KEY = "mega-compact";
const MARKER_TYPE = "mega-compact-marker";

/** Per-session runtime state kept in the closure (mirrors neuralwatt-mcr). */
interface SessionRuntime {
  sessionId: string;
  persistedThisSession: boolean;
  lastCheckpointId: string | undefined;
  lastCompactedFrom: number;
}

function envFlag(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v === "true" || v === "1";
}

function loadConfig() {
  return {
    stateDir: process.env.MEGACOMPACT_STATE_DIR ?? STATE_DIR_DEFAULT,
    fastGatePct: envFlag("MEGACOMPACT_FAST_GATE_PCT", 70),
    thresholdTokens: envFlag("MEGACOMPACT_THRESHOLD_TOKENS", 50000),
    anchorUserMessages: envFlag("MEGACOMPACT_ANCHOR_USER_MESSAGES", 3),
    preserveRecent: envFlag("MEGACOMPACT_PRESERVE_RECENT", 4),
    auto: envBool("MEGACOMPACT_AUTO", true),
    autoInline: envBool("MEGACOMPACT_AUTO_INLINE", true),
    autoInlineK: envFlag("MEGACOMPACT_AUTO_INLINE_K", 3),
    dedupSim: Number(process.env.MEGACOMPACT_DEDUP_SIM ?? "0.9"),
  };
}

/** Convert the messages pi hands us in the `context` event into the engine view. */
function engineView(messages: AgentMessage[]): EngineMessage[] {
  return toEngineMessages(messages);
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const store = new VectorStore({ dedupSim: config.dedupSim, stateDir: config.stateDir });

  // The only mutable per-session state. Reset on session_start / session_tree.
  let rt: SessionRuntime = {
    sessionId: normalizeSessionId(undefined),
    persistedThisSession: false,
    lastCheckpointId: undefined,
    lastCompactedFrom: 0,
  };
  let debounceUntil = 0;
  // Recall block produced by auto-inline (resume/branch) that the next
  // before_agent_start should prepend to the system prompt. Unset after use.
  let pendingRecallBlock: string | undefined;

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  function resetRuntime(sessionId: string | undefined) {
    const sid = normalizeSessionId(sessionId);
    if (rt.sessionId === sid && rt.persistedThisSession) return; // same session, keep checkpoint memory
    rt = {
      sessionId: sid,
      persistedThisSession: false,
      lastCheckpointId: undefined,
      lastCompactedFrom: 0,
    };
  }

  /** Run the full compaction pipeline and persist a checkpoint. Returns the result. */
  function runCompact(
    ctx: ExtensionContext,
    messages: AgentMessage[],
    opts: { keepFrom?: number; summary?: string } = {},
  ) {
    const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
    resetRuntime(sid);
    rt.sessionId = sid;

    const view = engineView(messages);
    const keepFrom = opts.keepFrom ?? Math.max(0, view.length - config.preserveRecent);
    if (keepFrom <= 0) return { skipped: true as const };

    const result = compactSession(
      {
        sessionId: sid,
        messages: view,
        keepFrom,
        summary: opts.summary,
        timestamp: Date.now(),
      },
      store,
    );

    if (result.skipped) return { skipped: true as const };
    if (!result.deduped) {
      rt.persistedThisSession = true;
      rt.lastCheckpointId = result.checkpointId;
    }
    rt.lastCompactedFrom = result.compactedFrom;

    // Sentinel marker: a non-LLM bookkeeping entry so subsequent triggers can
    // skip re-vectorizing an already-compacted region (zero token cost).
    pi.appendEntry(MARKER_TYPE, {
      checkpointId: result.checkpointId,
      regionHash: result.regionHash,
      tokenEstimate: result.tokenEstimate,
      deduped: result.deduped,
    });

    const saved = result.tokenEstimate;
    setStatus(
      ctx,
      rt.persistedThisSession
        ? `mega-compact: ${result.checkpointId} · ${saved} tok saved`
        : `mega-compact: ready`,
    );
    return { skipped: false, result, keepFrom, saved };
  }

  /**
   * Unified recall (Layer 5). The ONE path that injects. Returns the recall
   * result; callers decide whether to stage it for before_agent_start (resume)
   * or report it (command).
   */
  function doRecall(ctx: ExtensionContext, query: string, source: "resume" | "command") {
    const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
    return recallAndInline(
      { sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true },
      store,
    );
  }

  // ---- Session lifecycle (state reset points) -------------------------------
  pi.on("session_start", async (event, ctx) => {
    resetRuntime(ctx.sessionManager.getSessionId());
    setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
    // Auto-inline on resume/fork: stage the most relevant checkpoints so the
    // next before_agent_start prepends them to the system prompt.
    if (config.autoInline && (event.reason === "resume" || event.reason === "fork")) {
      const query = recentUserQuery(ctx);
      if (query) {
        const r = doRecall(ctx, query, "resume");
        if (!r.empty) {
          pendingRecallBlock = r.block;
          setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt`);
        }
      }
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    // Branch navigation invalidates region indexes — reset checkpoint memory but
    // keep the on-disk store (markers replayed from entries below if needed).
    resetRuntime(ctx.sessionManager.getSessionId());
    setStatus(ctx, "mega-compact: ready (branch)");
    if (config.autoInline) {
      const query = recentUserQuery(ctx);
      if (query) {
        const r = doRecall(ctx, query, "resume");
        if (!r.empty) pendingRecallBlock = r.block;
      }
    }
  });

  // ---- Auto-inline injection point: prepend staged recall to systemPrompt ----
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!pendingRecallBlock) return;
    const block = pendingRecallBlock;
    pendingRecallBlock = undefined; // one-shot: consume so we never double-inject
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    setStatus(ctx, undefined);
  });

  // ---- Auto-trigger: fast-gate → confirm → Trident+persist → drop --------
  pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    if (!config.auto) return;
    const usage = ctx.getContextUsage();
    const pct = usage?.percent;
    if (pct == null) return;
    if (pct < config.fastGatePct) return; // FAST GATE (local %)

    const messages = event.messages;
    const view = engineView(messages);
    const currentTokens = estimateSessionTokens(view);
    const check = autoCompactCheck(currentTokens, config.thresholdTokens); // SERVER-STYLE CONFIRM (local)
    if (!check.shouldCompact) return;

    // Debounce so we don't fire on every context event past threshold.
    const now = Date.now();
    if (now < debounceUntil) return;
    debounceUntil = now + 2000;

    if (!ctx.isIdle()) return; // never compact mid-stream

    const ran = runCompact(ctx, messages);
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
    resetRuntime(ctx.sessionManager.getSessionId());
    if (rt.persistedThisSession) {
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

  // ---- Commands ----------------------------------------------------------
  pi.registerCommand("megacompact", {
    description: "Compress current session context into the local vector store.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sessionEntries = ctx.sessionManager.getEntries();
      // Project entries (branch-aware) into the message view.
      const messages: AgentMessage[] = sessionEntries.flatMap((e) => sessionEntryToContextMessages(e));
      const summaryArg = args.trim();
      const ran = runCompact(ctx, messages, summaryArg ? { summary: summaryArg } : {});
      if ("skipped" in ran && ran.skipped) {
        ctx.ui.notify("[mega-compact] Nothing to compact (session too small).");
        return;
      }
      const r = (ran as { result: { deduped: boolean; checkpointId?: string; tokenEstimate: number } }).result;
      ctx.ui.notify(
        `[mega-compact] ${r.deduped ? "region already compacted (deduped)" : `persisted ${r.checkpointId}`} · ` +
          `${r.tokenEstimate} tok · ${config.stateDir}`,
      );
    },
  });

  pi.registerCommand("recall-context", {
    description: "Recall relevant compacted context from the vector store and inline it.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const query = args.trim() || recentUserQuery(ctx);
      if (!query) {
        ctx.ui.notify("[mega-compact] /recall-context needs a query or a prior user message.");
        return;
      }
      const r = doRecall(ctx, query, "command");
      if (r.empty) {
        ctx.ui.notify(`[mega-compact] recall found nothing new for "${query}".`);
        return;
      }
      // Stage the block so the next before_agent_start prepends it (actual
      // injection). Report what was selected now for immediate feedback.
      pendingRecallBlock = r.block;
      const list = r.report.map((l) => l).join("\n");
      ctx.ui.notify(
        `[mega-compact] recall staged ${r.toInject.length} checkpoint(s) for "${query}":\n${list}\n` +
          `(injected at the next turn via system prompt)`,
      );
    },
  });

  pi.registerCommand("megacompact-status", {
    description: "Show mega-compact config and current context usage.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const usage = ctx.getContextUsage();
      const pct = usage?.percent != null ? `${usage.percent}%` : "n/a";
      ctx.ui.notify(
        `[mega-compact] pct=${pct} fastGate=${config.fastGatePct}% ` +
          `threshold=${config.thresholdTokens} auto=${config.auto} autoInline=${config.autoInline} ` +
          `anchor=${config.anchorUserMessages} dedupSim=${config.dedupSim} stateDir=${config.stateDir}`,
      );
    },
  });
}

/** Latest user message text — used as the auto-inline recall query. */
function recentUserQuery(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const msgs = sessionEntryToContextMessages(entries[i]);
      for (let j = msgs.length - 1; j >= 0; j--) {
        if (msgs[j].role === "user") {
          const c = (msgs[j] as { content: unknown }).content;
          if (typeof c === "string") return c;
          if (Array.isArray(c)) return c.map((b: any) => b.text).join(" ");
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return "";
}
