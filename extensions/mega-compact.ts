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
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR_DEFAULT } from "../src/config.js";
import { VectorStore } from "../src/vectorStore.js";
import { toEngineMessages, dropCompactedRange } from "../src/adapt.js";
import { compactSession } from "../src/engine.js";
import { recallAndInline } from "../src/recall.js";
import { autoCompactCheck } from "../src/compact.js";
import { estimateSessionTokens } from "../src/tokens.js";
import { normalizeSessionId } from "../src/store.js";
import { touchSession, logDaily } from "../src/store/sqlite.js";
import { Logger } from "../src/log.js";
import type { EngineMessage } from "../src/types.js";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process"; // guardrails-allow PREVENT-PI-004: spawns the optional, user-triggered localhost dashboard server only
import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: read-only `git rev-parse` to scope the store per-repo

const STATUS_KEY = "mega-compact";
const WIDGET_KEY = "mega-compact-stats";
const MARKER_TYPE = "mega-compact-marker";

/** Per-session runtime state kept in the closure (mirrors neuralwatt-mcr). */
interface SessionRuntime {
  sessionId: string;
  persistedThisSession: boolean;
  lastCheckpointId: string | undefined;
  lastCompactedFrom: number;
  lastCompactedTokens: number;
  dedupSkips: number;       // compactions skipped because regionHash already stored
  dedupAttempts: number;    // total compaction attempts (for hit-rate denominator)
  tokensSaved: number;      // this session-instance only: reset on session_start
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
    // Global default; the live store/dashboard are rebound per-repo at runtime
    // via bindRepo() so each git repo gets its own isolated state dir.
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

/**
 * Resolve the current repo's git root from a cwd. Returns undefined for a
 * non-git directory (caller falls back to a global state dir).
 */
function resolveRepoRoot(cwd: string): string | undefined {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-repo state dir: <repo>/.pi/mega-compact (tracked, so it travels with the
 * repo across devices — not gitignored). Falls back to `fallback` for non-git
 * cwds (the explicit MEGACOMPACT_STATE_DIR override, if set).
 */
function repoStateDir(cwd: string, fallback: string): string {
  const root = resolveRepoRoot(cwd);
  if (!root) return fallback;
  return join(root, ".pi", "mega-compact");
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
  // Store/dashboard/logger are rebound per-repo by bindRepo() (below) so each
  // git repo gets its own isolated state dir. They start bound to the global
  // default until the first handler resolves a cwd.
  let store = new VectorStore({ dedupSim: config.dedupSim, stateDir: config.stateDir });
  let logger = new Logger({ enabled: config.debug, path: join(config.stateDir, "mega-compact.log") });
  let dashboard = new Dashboard(config.stateDir);
  let activeRepoRoot: string | null = null;
  let currentStateDir = config.stateDir;

  /**
   * Point store/dashboard/logger at the current repo's state dir. Rebuilds the
   * instances only when the repo root changes, so cross-repo dedup stats, db,
   * and events are fully isolated. Falls back to the global default outside git.
   */
  function bindRepo(cwd: string | undefined): string {
    const dir = cwd ? repoStateDir(cwd, config.stateDir) : config.stateDir;
    const key = cwd ? resolveRepoRoot(cwd) ?? dir : dir;
    if (key === activeRepoRoot) return dir;
    activeRepoRoot = key;
    currentStateDir = dir;
    store = new VectorStore({ dedupSim: config.dedupSim, stateDir: dir });
    logger = new Logger({ enabled: config.debug, path: join(dir, "mega-compact.log") });
    dashboard = new Dashboard(dir);
    return dir;
  }

  // --- snapshot() helper: collect live state and write it to disk ---
  let lastCtxTokens: number | null = null;
  let lastCtxPercent: number | null = null;
  let lastCtxWindow: number = 0;

  function snapshot(ctx?: ExtensionContext): void {
    if (ctx) bindRepo(ctx.cwd);
    const st = store.stats(rt.sessionId);
    const repo = store.repoStats();
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
        lastCompactedTokens: rt.lastCompactedTokens,
        dedupSkips: rt.dedupSkips,
        dedupAttempts: rt.dedupAttempts,
      },
      context: { tokens: lastCtxTokens, percent: lastCtxPercent, contextWindow: lastCtxWindow },
      trigger: { armed, ready, currentTokens: lastCtxTokens, thresholdTokens: config.thresholdTokens, fastGatePct: config.fastGatePct },
      crew: { activeAgents, currentTurn },
      store: { checkpointCount: st.checkpointCount, totalTokenEstimate: st.totalTokenEstimate, originalTokens: st.originalTokens, tokensSaved: rt.tokensSaved, injectedCount: st.injectedCount, dedupHitRate: st.dedupHitRate, storageDedupRate: st.storageDedupRate, dedupAttempts: st.dedupAttempts, dedupCollapsed: st.dedupCollapsed },
      repo: {
        checkpointCount: repo.checkpointCount,
        totalTokenEstimate: repo.totalTokenEstimate,
        originalTokens: repo.originalTokens,
        tokensSaved: repo.tokensSaved,
        sessionCount: repo.sessionCount,
        dedupAttempts: repo.dedupAttempts,
        dedupCollapsed: repo.dedupCollapsed,
        storageDedupRate: repo.storageDedupRate,
      },
    });

    // Live stats widget above the editor
    if (ctx) {
      const tokStr = lastCtxTokens != null ? `${Math.round(lastCtxTokens / 1000)}k` : "?";
      const maxStr = lastCtxWindow > 0 ? `${Math.round(lastCtxWindow / 1000)}k` : "?";
      const pctStr = lastCtxPercent != null ? `${Math.round(lastCtxPercent * 10) / 10}%` : "?%";
      const triggerLabel = ready ? `${C.green}● ready${C.reset}` : armed ? `${C.amber}◐ armed${C.reset}` : `${C.gray}○ idle${C.reset}`;
      // Storage dedup rate is cumulative (store-wide, per-repo) and survives
      // session resets. Always show a number: 0% before any compaction, a
      // decimal for sub-10% rates so small-but-real dedup isn't rounded away.
      const storageRate = st.storageDedupRate; // 0..1
      const dedupStr = storageRate * 100 >= 10
        ? `${Math.round(storageRate * 100)}%`
        : `${(storageRate * 100).toFixed(1)}%`;
      // saved = tokens removed from context (cumulative original − stored).
      // Show BOTH this-session (rt.tokensSaved) and repo-wide-total
      // (repo.tokensSaved) so the user sees per-session progress vs the running
      // repo total. "used" = stored checkpoint tokens (repo.totalTokenEstimate
      // vs st.totalTokenEstimate). Use "k" only at/above 1000 so small-but-real
      // numbers stay visible (previously Math.round(x/1000) zeroed <1000).
      const fmt = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : `${x}`);
      const savedStr = `${C.green}${fmt(rt.tokensSaved)} sess${C.reset} / ${C.blue}${fmt(repo.tokensSaved)} repo${C.reset}`;
      const usedStr = `${C.cyan}${fmt(st.totalTokenEstimate)} sess${C.reset} / ${C.blue}${fmt(repo.totalTokenEstimate)} repo${C.reset}`;
      const agentStr = activeAgents > 0 ? ` │ 🤖 ${activeAgents} agent${activeAgents === 1 ? "" : "s"}` : "";
      const turnStr = currentTurn > 0 ? ` │ turn ${currentTurn}` : "";
      const lines = [
        ` ${C.amber}⚡ ${config.tier}${C.reset} │ ${tokStr}/${maxStr} tokens (${C.bold}${pctStr}${C.reset}) │ ${st.checkpointCount} chkpt${st.checkpointCount === 1 ? "" : "s"}${agentStr}${turnStr}`,
        `   ${triggerLabel} │ ${C.magenta}dedup: ${dedupStr}${C.reset} │ ${C.gray}used:${C.reset} ${usedStr} │ ${C.gray}saved:${C.reset} ${savedStr}`,
      ];
      // Live "now processing" line — teal while fresh (≤4s), then the last-seen
      // action keeps the widget lively. Cleared on session reset.
      if (currentActivity) {
        const fresh = Date.now() - lastActivityAt < 4000;
        lines.push(`   ${fresh ? C.teal : C.dim}${currentActivity}${C.reset}`);
      }
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    }
  }

  // The only mutable per-session state. Reset on session_start / session_tree.
  let rt: SessionRuntime = {
    sessionId: normalizeSessionId(undefined),
    persistedThisSession: false,
    lastCheckpointId: undefined,
    lastCompactedFrom: 0,
    lastCompactedTokens: 0,
    dedupSkips: 0,
    dedupAttempts: 0,
    tokensSaved: 0,
  };
  let debounceUntil = 0;
  // Agent tracking for real-time widget updates
  let activeAgents = 0;
  let currentTurn = 0;
  // Recall block produced by auto-inline (resume/branch) that the next
  // before_agent_start should prepend to the system prompt. Unset after use.
  let pendingRecallBlock: string | undefined;
  let statusKey: string | undefined; // current status text for dashboard
  // Live "what it's doing right now" line for the toolbar. Set on each
  // compaction; shown in teal while recent, then kept as the last-seen action so
  // the widget is never blank. Cleared on session reset.
  let currentActivity: string | undefined;
  let lastActivityAt = 0;
  // ANSI palette for the toolbar. The pi TUI's Text component preserves ANSI
  // escape codes (see wrapTextWithAnsi), so raw escapes render as colors. No
  // chalk dependency needed — these are just strings.
  const C = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    amber: "\x1b[38;5;214m", // tier / ready
    green: "\x1b[38;5;120m", // saved
    cyan: "\x1b[38;5;51m", // used / live activity
    teal: "\x1b[38;5;37m", // processing (compress/dedup)
    magenta: "\x1b[38;5;201m", // dedup rate
    blue: "\x1b[38;5;75m", // repo totals
    gray: "\x1b[38;5;245m", // labels
  };

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
      lastCompactedTokens: 0,
      dedupSkips: 0,
      dedupAttempts: 0,
      tokensSaved: 0,
    };
    statusKey = undefined;
    activeAgents = 0;
    currentTurn = 0;
    currentActivity = undefined;
    lastActivityAt = 0;
  }

  /** Run the full compaction pipeline and persist a checkpoint. Returns the result. */
  function runCompact(
    ctx: ExtensionContext,
    messages: AgentMessage[],
    opts: { keepFrom?: number; summary?: string } = {},
  ) {
    bindRepo(ctx.cwd);
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
    rt.lastCompactedTokens = result.tokenEstimate;
    rt.dedupAttempts++;
    // Honest "tokens saved" for this session-instance only:
    //   new checkpoint      → original − stored
    //   deduped onto existing → whole original region (nothing new stored)
    // Resets to 0 on session_start (rt is rebuilt) — so a fresh session shows 0
    // while the repo's cumulative saved (SQLite meta) keeps the running total.
    const saved = result.deduped
      ? result.originalTokenEstimate
      : Math.max(0, result.originalTokenEstimate - result.tokenEstimate);
    rt.tokensSaved += saved;
    if (result.deduped) rt.dedupSkips++;

    // Live toolbar "now processing" line: what file/region just got compacted or
    // deduped. Reset to the last-seen action after a few seconds (see snapshot).
    const files = result.filesModified ?? [];
    const fileLabel = files.length
      ? files.map((f) => f.split("/").pop() ?? f).slice(0, 2).join(", ")
      : result.regionHash.slice(0, 8);
    currentActivity = result.deduped
      ? `♻ deduped ${fileLabel}`
      : `🗜 compacted ${result.checkpointId} · ${fileLabel}`;
    lastActivityAt = Date.now();

    // Record session activity + a daily-log entry in the per-repo SQLite store
    // (foundation for resume-sessions / daily-log features). Best-effort — never
    // block a compaction on bookkeeping.
    try {
      const repo = resolveRepoRoot(ctx.cwd);
      touchSession(sid, repo, currentStateDir);
      logDaily(sid, "compact", result.checkpointId, saved, currentStateDir);
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
    snapshot(ctx);
    return { skipped: false, result, keepFrom, saved };
  }

  /**
   * Unified recall (Layer 5). The ONE path that injects. Returns the recall
   * result; callers decide whether to stage it for before_agent_start (resume)
   * or report it (command).
   */
  function doRecall(ctx: ExtensionContext, query: string, source: "resume" | "command") {
    bindRepo(ctx.cwd);
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
    snapshot(ctx);
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
    snapshot(ctx);
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
    activeAgents = 0;
    currentTurn = 0;
    ctx.ui.setWidget(WIDGET_KEY, [], { placement: "aboveEditor" });
  });

  // ---- Agent tracking for real-time widget + status-line updates ---------
  pi.on("agent_start", async (_event, ctx) => {
    activeAgents++;
    dashboard.event("agent_start", { activeAgents });
    // Surface live agent activity on the status line (toolbar), not just the
    // above-editor widget — otherwise concurrent agents look frozen.
    setStatus(ctx, `mega-compact: ▶ ${activeAgents} agent${activeAgents === 1 ? "" : "s"}`);
    snapshot(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    activeAgents = Math.max(0, activeAgents - 1);
    dashboard.event("agent_end", { activeAgents });
    if (activeAgents > 0) {
      setStatus(ctx, `mega-compact: ▶ ${activeAgents} agent${activeAgents === 1 ? "" : "s"}`);
    } else {
      setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
    }
    snapshot(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    currentTurn = event.turnIndex;
    dashboard.event("turn_start", { turnIndex: event.turnIndex });
    snapshot(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    dashboard.event("turn_end", { turnIndex: event.turnIndex });
    snapshot(ctx);
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
    snapshot(ctx);
    if (pct == null) return;

    const messages = event.messages;
    const view = engineView(messages);
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
  pi.registerCommand("mega-compact", {
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
          `${r.tokenEstimate} tok · ${currentStateDir}`,
      );
    },
  });

  pi.registerCommand("mega-recall", {
    description: "Recall relevant compacted context from the vector store and inline it.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const query = args.trim() || recentUserQuery(ctx);
      if (!query) {
        ctx.ui.notify("[mega-compact] /mega-recall needs a query or a prior user message.");
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

  pi.registerCommand("mega-status", {
    description: "Show mega-compact config and current context usage.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      bindRepo(ctx.cwd);
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
          `[mega-compact] stateDir=${currentStateDir}`,
      );
    },
  });

  pi.registerCommand("mega-tier", {
    description: "Show or change the compaction tier at runtime. Usage: /mega-tier [low|medium|high|ultra|mega]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        // Show current tier and available options.
        ctx.ui.notify(
          `[mega-compact] current tier: ${config.tier} (${config.thresholdTokens} tok)\n` +
          `[mega-compact] available tiers: ${Object.entries(COMPACT_TIERS).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        );
        return;
      }
      if (!(arg in COMPACT_TIERS)) {
        ctx.ui.notify(`[mega-compact] unknown tier "${arg}". Available: ${Object.keys(COMPACT_TIERS).join(", ")}`);
        return;
      }
      const newTier = arg as CompactTier;
      config.tier = newTier;
      config.thresholdTokens = COMPACT_TIERS[newTier];
      setStatus(ctx, `mega-compact: tier → ${newTier} (${config.thresholdTokens} tok)`);
      ctx.ui.notify(`[mega-compact] tier changed to ${newTier} (threshold: ${config.thresholdTokens} tokens)`);
      snapshot(ctx);
    },
  });

  // ---- Dashboard server commands ----------------------------------------

  const portFile = join(currentStateDir, "port.pid");
  const runnerFile = join(currentStateDir, "_dashboard-runner.mjs");
  const launchLog = join(currentStateDir, "_dashboard-launch.log");
  // Whether the runner must be spawned with --experimental-strip-types (true only
  // when we fall back to the .ts source outside node_modules; false when using
  // the shipped compiled dist/extensions/dashboard-server.js).
  let dashboardNeedsStrip = false;

  // The dashboard server binds 9320–9329 (TARGET_PORT..TARGET_PORT+PORT_RANGE-1
  // in dashboard-server.js). Probe each for a live /api/snapshot so we can detect
  // readiness even when port.pid landed in a different state dir than we poll.
  async function findLivePort(): Promise<number | null> {
    for (let port = 9320; port <= 9329; port++) {
      try {
        const res = await fetch(`http://localhost:${port}/api/snapshot`, { signal: AbortSignal.timeout(800) }); // guardrails-allow PREVENT-PI-004: localhost liveness probe of the dashboard server this extension spawned
        if (res.ok) return port;
      } catch { /* not on this port — try next */ }
    }
    return null;
  }

  /** Try to reach a running dashboard server. Returns { port, url } or null. */
  async function isServerRunning(): Promise<{ port: number; url: string } | null> {
    const port = await findLivePort();
    if (!port) {
      // Stale marker with no live server behind it — clean up.
      if (existsSync(portFile)) {
        try { unlinkSync(portFile); } catch { /* ignore */ }
      }
      return null;
    }
    return { port, url: `http://localhost:${port}` }; // guardrails-allow PREVENT-PI-004: localhost URL of the dashboard server this extension spawned
  }

  /**
   * Resolve the launchable dashboard-server module.
   *
   * CRITICAL: Node's `--experimental-strip-types` REFUSES to strip .ts files that
   * live under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Since
   * the published package installs under node_modules, importing the .ts source
   * fails in every real install (it only worked from a source checkout). So we
   * prefer the COMPILED dist/extensions/dashboard-server.js (which the package
   * ships from v0.4.6 — it imports only Node built-ins, so it runs standalone),
   * and only fall back to the .ts source (with strip-types) when the compiled
   * file is absent AND we're not under node_modules (dev checkout without a build).
   *
   * Returns { entry, needsStripTypes }.
   */
  function resolveDashboardEntry(): { entry: string; needsStripTypes: boolean } | null {
    const here = dirname(fileURLToPath(import.meta.url)); // .../extensions
    const candidates = [
      // 1. Compiled sibling when running from dist/ (import.meta is dist/extensions/…js)
      { entry: join(here, "dashboard-server.js"), strip: false },
      // 2. Compiled under the package's dist/ when running from source extensions/…ts
      { entry: join(here, "..", "dist", "extensions", "dashboard-server.js"), strip: false },
      // 3. Last resort: the .ts source (only strippable OUTSIDE node_modules)
      { entry: join(here, "dashboard-server.ts"), strip: true },
    ];
    for (const c of candidates) {
      if (!existsSync(c.entry)) continue;
      if (c.strip && c.entry.includes(`${sep}node_modules${sep}`)) continue; // unstrippable
      return { entry: c.entry, needsStripTypes: c.strip };
    }
    return null;
  }

  /** Write a small ESM runner script that imports and launches the dashboard server. */
  function writeRunnerScript(): boolean {
    const resolved = resolveDashboardEntry();
    if (!resolved) return false;
    dashboardNeedsStrip = resolved.needsStripTypes;
    const script = [
      `import { appendFileSync } from "node:fs";`,
      `const __log = ${JSON.stringify(launchLog)};`,
      `function __fail(err) {`,
      `  const msg = "[mega-compact] dashboard failed: " + (err && err.stack ? err.stack : String(err));`,
      `  try { appendFileSync(__log, msg + "\\n"); } catch { /* ignore */ }`,
      `  console.error(msg);`,
      `  process.exit(1);`,
      `}`,
      `import { launchDashboardServer } from ${JSON.stringify(resolved.entry)};`,
      `launchDashboardServer(${JSON.stringify(currentStateDir)}).catch(__fail);`,
    ].join("\n");
    writeFileSync(runnerFile, script);
    return true;
  }

  /** Open a URL in the default browser. Platform-aware. Uses spawn (not exec) to avoid shell injection. */
  function openBrowser(url: string): void {
    const cmd =
      process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "start" :
          "xdg-open";
    try {
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* non-fatal — user can open manually */
    }
  }

  pi.registerCommand("mega-dashboard", {
    description: "Start the local web dashboard and optionally open it in the default browser.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      bindRepo(ctx.cwd);
      let info = await isServerRunning();

      if (info) {
        ctx.ui.notify(`[mega-compact] dashboard already running at ${info.url}`);
        const open = await ctx.ui.confirm("mega-compact dashboard", `Open ${info.url} in browser?`);
        if (open) openBrowser(info.url);
        return;
      }

      // Start the server
      ctx.ui.notify("[mega-compact] starting dashboard server…");
      if (!writeRunnerScript()) {
        ctx.ui.notify("[mega-compact] dashboard entry not found — check logs.");
        return;
      }

      const args = dashboardNeedsStrip ? ["--experimental-strip-types", runnerFile] : [runnerFile];
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Poll for a live server (port 9320–9329) instead of relying solely on the
      // port.pid marker, which can land in a different state dir than the one we
      // poll when a prior compact left currentStateDir pointing elsewhere.
      const deadline = Date.now() + 6_000;
      let port: number | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        port = await findLivePort();
        if (port) break;
      }

      if (!port) {
        let detail = "";
        try {
          const log = readFileSync(launchLog, "utf-8").trim();
          if (log) detail = ` — ${log.split("\n").slice(-3).join("; ")}`;
        } catch { /* no log yet */ }
        ctx.ui.notify(`[mega-compact] dashboard server failed to start${detail}. See ${launchLog}`);
        return;
      }

      const url = `http://localhost:${port}`; // guardrails-allow PREVENT-PI-004: localhost URL of the dashboard server this extension spawned
      ctx.ui.notify(`[mega-compact] dashboard running at ${url}`);
      const open = await ctx.ui.confirm("mega-compact dashboard", `Open ${url} in browser?`);
      if (open) openBrowser(url);
    },
  });

  pi.registerCommand("mega-dashboard-stop", {
    description: "Stop the local dashboard server.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!existsSync(portFile)) {
        ctx.ui.notify("[mega-compact] no dashboard server running.");
        return;
      }
      try {
        const info = JSON.parse(readFileSync(portFile, "utf-8"));
        // Verify the server is actually ours by probing the port before killing
        try {
          await fetch(`http://localhost:${info.port}/api/snapshot`, { signal: AbortSignal.timeout(1000) }); // guardrails-allow PREVENT-PI-004: localhost probe to verify the dashboard server is ours before stopping it
        } catch {
          // Not responding — just clean up stale pid file
          try { unlinkSync(portFile); } catch { /* ok */ }
          ctx.ui.notify("[mega-compact] dashboard was not running (stale pid file cleaned up).");
          return;
        }
        if (info?.pid) process.kill(info.pid, "SIGTERM");
      } catch { /* already dead */ }
      try { unlinkSync(portFile); } catch { /* ok */ }
      ctx.ui.notify("[mega-compact] dashboard stopped.");
    },
  });

  pi.registerCommand("mega-dashboard-status", {
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
