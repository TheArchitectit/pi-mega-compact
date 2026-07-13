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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR_DEFAULT } from "../src/config.js";
import { VectorStore } from "../src/vectorStore.js";
import { toEngineMessages, dropCompactedRange } from "../src/adapt.js";
import { compactSession } from "../src/engine.js";
import { recallAndInline } from "../src/recall.js";
import { autoCompactCheck } from "../src/compact.js";
import { estimateSessionTokens } from "../src/tokens.js";
import { normalizeSessionId } from "../src/store.js";
import { Logger } from "../src/log.js";
import type { EngineMessage } from "../src/types.js";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { spawn, exec } from "node:child_process";

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

/**
 * Named compaction tiers. A tier sets the token threshold at which the
 * auto-trigger persists a checkpoint; pick by how aggressively you want the
 * session trimmed. Explicit MEGACOMPACT_THRESHOLD_TOKENS always wins.
 */
const COMPACT_TIERS = {
  low: 50_000,
  medium: 100_000,
  high: 200_000,
  ultra: 1_000_000,
  mega: 10_000_000,
} as const;
export type CompactTier = keyof typeof COMPACT_TIERS;

/** Resolve the effective token threshold from TIER (or explicit) env vars. */
function resolveThreshold(): { tier: CompactTier | "custom"; thresholdTokens: number } {
  const explicit = process.env.MEGACOMPACT_THRESHOLD_TOKENS;
  if (explicit != null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n)) return { tier: "custom", thresholdTokens: n };
  }
  const raw = (process.env.MEGACOMPACT_TIER ?? "low").toLowerCase();
  const tier = (raw in COMPACT_TIERS ? raw : "low") as CompactTier;
  return { tier, thresholdTokens: COMPACT_TIERS[tier] };
}

function loadConfig() {
  const { tier, thresholdTokens } = resolveThreshold();
  return {
    tier,
    stateDir: process.env.MEGACOMPACT_STATE_DIR ?? STATE_DIR_DEFAULT,
    fastGatePct: envFlag("MEGACOMPACT_FAST_GATE_PCT", 70),
    thresholdTokens,
    anchorUserMessages: envFlag("MEGACOMPACT_ANCHOR_USER_MESSAGES", 3),
    preserveRecent: envFlag("MEGACOMPACT_PRESERVE_RECENT", 4),
    auto: envBool("MEGACOMPACT_AUTO", true),
    autoInline: envBool("MEGACOMPACT_AUTO_INLINE", true),
    autoInlineK: envFlag("MEGACOMPACT_AUTO_INLINE_K", 3),
    dedupSim: Number(process.env.MEGACOMPACT_DEDUP_SIM ?? "0.9"),
    debug: envBool("MEGACOMPACT_DEBUG", false),
  };
}

// ---- Live dashboard -------------------------------------------------------
// Writes dashboard.json (full snapshot) and events.log (JSONL tail) to the
// state dir so any process can inspect the extension's real-time state.
//
// Usage:
//   cat ~/.pi/agent/extensions/pi-mega-compact/dashboard.json
//   jq . ~/.pi/agent/extensions/pi-mega-compact/dashboard.json
//   tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log

interface DashboardSnapshot {
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
    injectedCount: number;
    dedupHitRate: number;
  };
}

class Dashboard {
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

/** Convert the messages pi hands us in the `context` event into the engine view. */
function engineView(messages: AgentMessage[]): EngineMessage[] {
  return toEngineMessages(messages);
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const store = new VectorStore({ dedupSim: config.dedupSim, stateDir: config.stateDir });
  const logger = new Logger({ enabled: config.debug, path: join(config.stateDir, "mega-compact.log") });
  const dashboard = new Dashboard(config.stateDir);

  // --- snapshot() helper: collect live state and write it to disk ---
  let lastCtxTokens: number | null = null;
  let lastCtxPercent: number | null = null;
  let lastCtxWindow: number = 0;

  function snapshot(): void {
    const st = store.stats(rt.sessionId);
    const armed = lastCtxPercent != null && lastCtxPercent >= config.fastGatePct;
    const ready = armed && (lastCtxTokens ?? 0) >= config.thresholdTokens;
    dashboard.snapshot({
      version: 1,
      updatedAt: new Date().toISOString(),
      tier: config.tier,
      config: {
        fastGatePct: config.fastGatePct,
        thresholdTokens: config.thresholdTokens,
        anchorUserMessages: config.anchorUserMessages,
        preserveRecent: config.preserveRecent,
        auto: config.auto,
        autoInline: config.autoInline,
      },
      session: {
        id: rt.sessionId,
        state: statusKey ?? "idle",
        persistedThisSession: rt.persistedThisSession,
        lastCheckpointId: rt.lastCheckpointId ?? null,
        lastCompactedFrom: rt.lastCompactedFrom,
      },
      context: { tokens: lastCtxTokens, percent: lastCtxPercent, contextWindow: lastCtxWindow },
      trigger: { armed, ready, currentTokens: lastCtxTokens, thresholdTokens: config.thresholdTokens, fastGatePct: config.fastGatePct },
      store: { checkpointCount: st.checkpointCount, totalTokenEstimate: st.totalTokenEstimate, injectedCount: st.injectedCount, dedupHitRate: st.dedupHitRate },
    });
  }

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
  let statusKey: string | undefined; // current status text for dashboard

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    statusKey = text;
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
    statusKey = undefined;
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
    logger.info("compact", {
      sessionId: sid,
      checkpointId: result.checkpointId ?? "(deduped)",
      deduped: result.deduped,
      tokenEstimate: saved,
      compactedFrom: result.compactedFrom,
    });
    dashboard.event("compact", {
      sessionId: sid,
      checkpointId: result.checkpointId ?? "(deduped)",
      deduped: result.deduped,
      tokenEstimate: saved,
      compactedFrom: result.compactedFrom,
    });
    snapshot();
    return { skipped: false, result, keepFrom, saved };
  }

  /**
   * Unified recall (Layer 5). The ONE path that injects. Returns the recall
   * result; callers decide whether to stage it for before_agent_start (resume)
   * or report it (command).
   */
  function doRecall(ctx: ExtensionContext, query: string, source: "resume" | "command") {
    const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
    const result = recallAndInline(
      { sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true },
      store,
    );
    dashboard.event("recall", { source, query: query.slice(0, 120), injected: result.toInject.length, empty: result.empty });
    return result;
  }

  // ---- Session lifecycle (state reset points) -------------------------------
  pi.on("session_start", async (event, ctx) => {
    resetRuntime(ctx.sessionManager.getSessionId());
    setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
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
      if (query && store.stats(sid).checkpointCount > 0) {
        const r = doRecall(ctx, query, "resume");
        if (!r.empty) {
          pendingRecallBlock = r.block;
          setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt`);
          logger.info("auto-inline", { reason: event.reason, query, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
        }
      }
    }
    dashboard.event("session_start", { reason: event.reason, sessionId: rt.sessionId });
    snapshot();
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
        if (!r.empty) {
          pendingRecallBlock = r.block;
          logger.info("auto-inline", { reason: "session_tree", query, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
        }
      }
    }
    dashboard.event("session_tree", { sessionId: rt.sessionId });
    snapshot();
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
    // Always track context for the dashboard, even if we return early below.
    lastCtxTokens = usage?.tokens ?? null;
    lastCtxPercent = pct ?? null;
    lastCtxWindow = usage?.contextWindow ?? 0;
    snapshot();
    if (pct == null) return;
    if (pct < config.fastGatePct) return; // FAST GATE (local %)

    const messages = event.messages;
    const view = engineView(messages);
    // Prefer the runtime's real token estimate; fall back to our heuristic
    // (and to a percent-of-window proxy when tokens is unknown).
    const currentTokens =
      usage?.tokens ?? estimateSessionTokens(view) ??
      Math.round((pct / 100) * (usage?.contextWindow ?? 0));
    const check = autoCompactCheck(currentTokens, config.thresholdTokens); // SERVER-STYLE CONFIRM (local)
    if (!check.shouldCompact) return;

    // Debounce so we don't fire on every context event past threshold.
    const now = Date.now();
    if (now < debounceUntil) return;
    debounceUntil = now + 2000;

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
        logger.info("recall-empty", { query });
        ctx.ui.notify(`[mega-compact] recall found nothing new for "${query}".`);
        return;
      }
      // Stage the block so the next before_agent_start prepends it (actual
      // injection). Report what was selected now for immediate feedback.
      pendingRecallBlock = r.block;
      const list = r.report.map((l) => l).join("\n");
      logger.info("recall", { query, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
      setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt`);
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
      const tokens = usage?.tokens != null ? `${usage.tokens} tok` : "n/a";
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const st = store.stats(sid);
      ctx.ui.notify(
        `[mega-compact] pct=${pct} tokens=${tokens} tier=${config.tier} fastGate=${config.fastGatePct}% ` +
          `threshold=${config.thresholdTokens} auto=${config.auto} autoInline=${config.autoInline}\n` +
          `[mega-compact] store: ${st.checkpointCount} chkpt · ` +
          `${st.totalTokenEstimate} tok · last=${st.lastCheckpointId ?? "—"} · ` +
          `injected=${st.injectedCount} · dedup=${(st.dedupHitRate * 100).toFixed(0)}%\n` +
          `[mega-compact] anchor=${config.anchorUserMessages} preserveRecent=${config.preserveRecent} ` +
          `autoInlineK=${config.autoInlineK} dedupSim=${config.dedupSim} debug=${config.debug}\n` +
          `[mega-compact] stateDir=${config.stateDir}`,
      );
    },
  });

  // ---- Dashboard server commands ----------------------------------------

  const portFile = join(config.stateDir, "port.pid");
  const runnerFile = join(config.stateDir, "_dashboard-runner.mjs");

  /** Try to reach a running dashboard server. Returns { port, url } or null. */
  async function isServerRunning(): Promise<{ port: number; url: string } | null> {
    if (!existsSync(portFile)) return null;
    try {
      const info = JSON.parse(readFileSync(portFile, "utf-8"));
      if (!info?.port) return null;
      const url = `http://localhost:${info.port}`;
      // Quick liveness probe
      const res = await fetch(`${url}/api/snapshot`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { port: info.port, url };
    } catch {
      // stale or unreachable — clean up
      try { writeFileSync(portFile, ""); } catch { /* ignore */ }
    }
    return null;
  }

  /** Write a small ESM runner script that imports and launches the dashboard server. */
  function writeRunnerScript(): void {
    const compiledServer = join(dirname(fileURLToPath(import.meta.url)), "dashboard-server.js");
    const script = [
      `import { launchDashboardServer } from ${JSON.stringify(compiledServer)};`,
      `launchDashboardServer(${JSON.stringify(config.stateDir)}).catch(err => {`,
      `  console.error("[mega-compact] dashboard failed:", err);`,
      `  process.exit(1);`,
      `});`,
    ].join("\n");
    writeFileSync(runnerFile, script);
  }

  /** Open a URL in the default browser. Platform-aware. */
  function openBrowser(url: string): void {
    const cmd =
      process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "start" :
          "xdg-open";
    try {
      exec(`${cmd} ${url}`);
    } catch {
      /* non-fatal — user can open manually */
    }
  }

  pi.registerCommand("dashboard", {
    description: "Start the local web dashboard and optionally open it in the default browser.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      let info = await isServerRunning();

      if (info) {
        ctx.ui.notify(`[mega-compact] dashboard already running at ${info.url}`);
        const open = await ctx.ui.confirm("mega-compact dashboard", `Open ${info.url} in browser?`);
        if (open) openBrowser(info.url);
        return;
      }

      // Start the server
      ctx.ui.notify("[mega-compact] starting dashboard server…");
      writeRunnerScript();

      const child = spawn(process.execPath, [runnerFile], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Poll for port.pid (up to 5 seconds)
      const deadline = Date.now() + 5_000;
      let port: number | undefined;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        if (existsSync(portFile)) {
          try {
            const raw = JSON.parse(readFileSync(portFile, "utf-8"));
            if (raw?.port) { port = raw.port; break; }
          } catch { /* keep polling */ }
        }
      }

      if (!port) {
        ctx.ui.notify("[mega-compact] dashboard server failed to start — check logs.");
        return;
      }

      const url = `http://localhost:${port}`;
      ctx.ui.notify(`[mega-compact] dashboard running at ${url}`);
      const open = await ctx.ui.confirm("mega-compact dashboard", `Open ${url} in browser?`);
      if (open) openBrowser(url);
    },
  });

  pi.registerCommand("dashboard-stop", {
    description: "Stop the local dashboard server.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!existsSync(portFile)) {
        ctx.ui.notify("[mega-compact] no dashboard server running.");
        return;
      }
      try {
        const info = JSON.parse(readFileSync(portFile, "utf-8"));
        if (info?.pid) process.kill(info.pid, "SIGTERM");
      } catch { /* already dead */ }
      try { writeFileSync(portFile, ""); } catch { /* ok */ }
      ctx.ui.notify("[mega-compact] dashboard stopped.");
    },
  });

  pi.registerCommand("dashboard-status", {
    description: "Check if the dashboard server is running.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const info = await isServerRunning();
      if (info) {
        ctx.ui.notify(`[mega-compact] dashboard running at ${info.url}`);
      } else {
        ctx.ui.notify("[mega-compact] dashboard is not running. Use /dashboard to start it.");
      }
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
