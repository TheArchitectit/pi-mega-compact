/**
 * mega-runtime.ts — the shared live state of the mega-compact extension.
 *
 * The original mega-compact.ts was a single large closure over ~20 mutable
 * variables. This module lifts that state into a `MegaRuntime` class so the
 * event/command/pipeline modules can share it without re-declaring it. All
 * behavior (store/dashboard rebinding, dashboard snapshot shape, the
 * above-editor widget math, model capture) is preserved byte-for-byte from the
 * original closure.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { VectorStore } from "../src/vectorStore.js";
import { toEngineMessages } from "../src/adapt.js";
import { normalizeSessionId } from "../src/store.js";
import { Logger } from "../src/log.js";
import { recordModelSnapshot, latestModelSnapshot, upsertRepoRegistry, recordRepoModel, type ModelSnapshot } from "../src/store/sqlite.js";
import { repoStateDir, resolveRepoRoot, pressureRatio, pressureFromPct, pressureBand, effectiveThresholdTokens, type MegaConfig, type PressureBand } from "./mega-config.js";
import { Dashboard, type DashboardSnapshot } from "./mega-dashboard.js";

export const STATUS_KEY = "mega-compact";
export const WIDGET_KEY = "mega-compact-stats";
export const MARKER_TYPE = "mega-compact-marker";

/** Cached npm version, read once from this extension's own package.json. */
let CACHED_VERSION: string | null = null;
function ownVersion(): string {
  if (CACHED_VERSION !== null) return CACHED_VERSION;
  let v = "?";
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // .../extensions
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
    v = pkg.version ?? "?";
  } catch {
    v = "?";
  }
  CACHED_VERSION = v;
  return v;
}

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

/** ANSI palette for the toolbar. The pi TUI's Text component preserves ANSI
 *  escape codes (see wrapTextWithAnsi), so raw escapes render as colors. No
 *  chalk dependency needed — these are just strings. */
export const C = {
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
  red: "\x1b[38;5;203m", // pressure / overflow
};

const PULSE = ["◐", "◓", "◑", "◒"];

// ── Full-width widget panel helpers ────────────────────────────────────────
// pi's above-editor widget renderer (a Container of Text lines) does NOT pass
// a terminal width to setWidget(), so lines render left-aligned by default. To
// make the widget read as a full-width status panel we pad each line to the
// real terminal width with a background fill. NOTE: C.reset is a FULL SGR
// reset, so we re-apply the panel bg after every reset to keep the background
// continuous under colored text (and under pi's own trailing reset).
const PANEL_BG = "\x1b[48;5;236m"; // dark slate panel background
const PANEL_RST = "\x1b[0m" + PANEL_BG; // reset fg but retain panel bg

/** Visible cell width of a string, ignoring ANSI SGR/OSC escapes. */
function visibleWidth(s: string): number {
  const stripped = s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = cp >= 0x1100 && (
      (cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    );
    w += wide ? 2 : 1;
  }
  return w;
}

/** Pad a content string (with ANSI colors) to `width` cells using panel bg. */
function panelLine(content: string, width: number): string {
  const withBg = PANEL_BG + content.replace(/\x1b\[0m/g, PANEL_RST);
  const pad = Math.max(0, width - visibleWidth(withBg));
  return withBg + " ".repeat(pad) + "\x1b[0m";
}

/** A full-width hairline bar (top/bottom border of the panel). */
function panelBar(width: number, ch = "─"): string {
  return PANEL_BG + ch.repeat(Math.max(0, width)) + "\x1b[0m";
}

interface TickerEntry { text: string; at: number; }

export class MegaRuntime {
  config: MegaConfig;
  // Store/dashboard/logger are rebound per-repo by bindRepo() so each git repo
  // gets its own isolated state dir. They start bound to the global default.
  store: VectorStore;
  logger: Logger;
  dashboard: Dashboard;
  activeRepoRoot: string | null = null;
  currentStateDir: string;

  // The only mutable per-session state. Reset on session_start / session_tree.
  rt: SessionRuntime = {
    sessionId: normalizeSessionId(undefined),
    persistedThisSession: false,
    lastCheckpointId: undefined,
    lastCompactedFrom: 0,
    lastCompactedTokens: 0,
    dedupSkips: 0,
    dedupAttempts: 0,
    tokensSaved: 0,
  };
  debounceUntil = 0;
  // S16: debounce for the agent_end resume nudge (avoid busy-loops).
  resumeNudgeUntil = 0;
  // Agent tracking for real-time widget updates
  activeAgents = 0;
  currentTurn = 0;
  // Recall block produced by auto-inline (resume/branch) that the next
  // before_agent_start should prepend to the system prompt. Unset after use.
  pendingRecallBlock: string | undefined;
  // S21: memory recall block, parallel to pendingRecallBlock. Same one-shot
  // semantics; composed with the checkpoint block in before_agent_start.
  pendingMemoryRecallBlock: string | undefined;
  statusKey: string | undefined; // current status text for dashboard
  // Active model/provider (for real cost estimation). Captured from ctx.model
  // on model_select + session_start; persisted to SQL so cost + the dashboard
  // can read it without a live ctx.
  currentModel: ModelSnapshot | undefined;
  // Live "what it's doing right now" timestamp, used for the fresh-window.
  lastActivityAt = 0;
  // Live per-tier dedup trace (Phase 1): e.g. "L0 ✓ → L1 ✓ → L2 0.91 → stored".
  // Built from the store's sync onTier callback during a compaction so the user
  // watches each tier evaluate in real time. Cleared once the outcome settles.
  tierTrace: string | undefined;
  // Phase 3 — standout toolbar state.
  // Recall/activity ticker: a small ring buffer (≤5) of recent compact/recall
  // events so the widget shows a live history instead of a single last action.
  ticker: TickerEntry[] = [];
  readonly TICKER_MAX = 5;
  // Pulsing status: set true while a compaction is in flight, cleared on result.
  pulsing = false;
  // S21.2: set by `applyMemoryOps` when a memory add/replace/remove lands in
  // the current compaction. The pipeline reads this after a successful compact
  // to decide whether to fire `consolidateMemories` (skip the work entirely
  // when no memory rows changed).
  memoriesTouchedThisCompaction = 0;
  // Rolling "saved" goal for the progress bar — grows as we save more, so the
  // bar always has a meaningful denominator (never sits at 100% forever).
  savedGoal = 50_000;
  // Last explain-why line (dedup reason / anchor-kept / superseded), surfaced
  // while fresh.
  lastWhy: string | undefined = undefined;

  // Context tracking for the dashboard (updated in the context handler).
  lastCtxTokens: number | null = null;
  lastCtxPercent: number | null = null;
  lastCtxWindow = 0;

  /**
   * DIAG counters for the "team run doesn't relieve context" investigation.
   * Plain integers, incremented at the three compaction decision points. They
   * let a headless test drive the real event handlers and assert the firing
   * cadence without scraping log files. Inert in production (the live-trim and
   * before-compact probes also emit logger.info, but these counters are always
   * updated and cost nothing).
   */
  diagLiveTrimFires = 0;     // context handler returned a trimmed view
  diagBeforeCompactFires = 0; // session_before_compact handler entered
  diagBeforeCompactSupplied = 0; // session_before_compact supplied our trim
  diagAgentEndIdle = 0;       // agent_end with activeAgents===0
  diagAgentEndDurable = 0;    // agent_end fired ctx.compact() (mid-run durable trim)
  // Per-skip-path counters for the team-run diagnosis.
  diagCtxFastGate = 0;        // returned at token fast-gate (below threshold)
  diagCtxNoCompact = 0;       // autoCompactCheck().shouldCompact === false
  diagCtxDebounce = 0;        // debounceUntil not yet elapsed
  diagCtxRunSkipped = 0;      // runCompact() returned skipped
  diagCtxCutNull = 0;         // computeLiveTrimCut returned null (anchor/boundary)
  diagCtxThrown = 0;          // live-trim try threw (caught)

  /**
   * S26 capture instrumentation: the "model_snapshots empty → $0.00 cost card"
   * bug was invisible because captureModel swallowed the DB write in a silent
   * `catch {}`. These always-updated counters (zero cost) let a headless test or
   * a live capture tell whether captureModel ran and whether the snapshot landed.
   */
  diagCaptureModelCalls = 0;   // captureModel entered with a populated ctx.model
  diagCaptureModelFails = 0;   // recordModelSnapshot threw → model_snapshots stays empty

  /**
   * Live 0–1 pressure — how full the context window is relative to the
   * compaction threshold.
   *
   * RECONCILE (BACKLOG dual-basis flicker): when the model context window is
   * known we base pressure consistently on the *percentage* basis
   * (`lastCtxPercent / (tierPct*100)`). This keeps the band stable whether the
   * latest context event carried a token count or only a percentage, so the
   * threshold comparison doesn't jump when a token-count event arrives vs a
   * percent-only event. We only fall back to the token-count basis
   * (`config.thresholdTokens`) when the window is unknown (e.g. before the first
   * context event, or a `custom` tier with no tierPct). Always finite + in [0,1].
   */
  get pressure(): number {
    if (this.lastCtxWindow > 0 && this.config.tierPct != null && this.lastCtxPercent != null) {
      // pressureFromPct(x) = x/100, and x = lastCtxPercent/tierPct, so this is
      // exactly the intended lastCtxPercent/(tierPct*100) 0–1 ratio: at the
      // fire point (lastCtxPercent == tierPct*100) pressure == 1.0, matching the
      // token-based pressureRatio(currentTokens, effectiveThreshold) reading so
      // the band doesn't jump when a token-count vs percent-only event arrives.
      return pressureFromPct(this.lastCtxPercent / this.config.tierPct);
    }
    if (this.lastCtxTokens != null && this.lastCtxTokens > 0 && this.config.thresholdTokens > 0) {
      return pressureRatio(this.lastCtxTokens, this.config.thresholdTokens);
    }
    return pressureFromPct(this.lastCtxPercent);
  }

  /**
   * The live compaction FIRE POINT in tokens: the effective threshold scaled by
   * the current model context window (`tierPct * window`) when known, else the
   * boot fallback `config.thresholdTokens`. This is what the FAST GATE /
   * `autoCompactCheck` / agent_end durable-trigger compare against, so
   * compaction fires at tier% of the window for ANY model size (200k or 1M),
   * always below pi's native auto-compaction (~80% of window).
   */
  get effectiveThreshold(): number {
    return effectiveThresholdTokens({
      tierPct: this.config.tierPct,
      fallbackThreshold: this.config.thresholdTokens,
      window: this.lastCtxWindow,
    });
  }

  /** Live discrete pressure band (low/medium/high/ultra/mega) over `pressure`. */
  get pressureBand(): PressureBand {
    return pressureBand(this.pressure);
  }

  constructor(config: MegaConfig) {
    this.config = config;
    this.store = new VectorStore({ dedupSim: config.dedupSim, stateDir: config.stateDir });
    this.logger = new Logger({ enabled: config.debug, path: join(config.stateDir, "mega-compact.log") });
    this.dashboard = new Dashboard(config.stateDir);
    this.currentStateDir = config.stateDir;
  }

  // ---- per-repo binding -----------------------------------------------------

  /**
   * Point store/dashboard/logger at the current repo's state dir. Rebuilds the
   * instances only when the repo root changes, so cross-repo dedup stats, db,
   * and events are fully isolated. Falls back to the global default outside git.
   */
  bindRepo(cwd: string | undefined): string {
    const dir = cwd ? repoStateDir(cwd, this.config.stateDir) : this.config.stateDir;
    const key = cwd ? resolveRepoRoot(cwd) ?? dir : dir;
    if (key === this.activeRepoRoot) return dir;
    this.activeRepoRoot = key;
    this.currentStateDir = dir;
    this.store = new VectorStore({ dedupSim: this.config.dedupSim, stateDir: dir });
    this.logger = new Logger({ enabled: this.config.debug, path: join(dir, "mega-compact.log") });
    this.dashboard = new Dashboard(dir);
    // Aggregate this repo into the machine-wide index so the multi-repo
    // dashboard (Summary / All-repos tabs) can show it alongside every other
    // repo. Best-effort + non-fatal: a read-only index dir or contention must
    // never break the per-repo compaction path. Runs only on repo-switch
    // (this branch), so it's infrequent — not per-context-event.
    try {
      const repo = this.store.repoStats();
      const di = this.store.dataInvariant();
      const root = key !== dir ? key : resolveRepoRoot(cwd ?? dir) ?? dir;
      upsertRepoRegistry({
        repoRoot: root,
        displayName: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
        stateDir: dir,
        checkpointCount: repo.checkpointCount,
        tokensSaved: repo.tokensSaved,
        compressedOriginalBytes: di.compressedOriginalBytes,
      });
    } catch {
      /* non-fatal: index aggregation must not block compaction */
    }
    return dir;
  }

  // ---- dashboard snapshot + widget ------------------------------------------

  /** Collect live state and write it to disk (+ paint the above-editor widget). */
  snapshot(ctx?: ExtensionContext): void {
    if (ctx) this.bindRepo(ctx.cwd);
    const st = this.store.stats(this.rt.sessionId);
    const repo = this.store.repoStats();
    const di = this.store.dataInvariant();
    // Active model/provider for the current-repo card + the multi-repo table.
    const modelSnap = latestModelSnapshot(this.currentStateDir);
    const model = modelSnap
      ? {
          name: modelSnap.modelName ?? modelSnap.modelId,
          provider: modelSnap.provider,
          providerName: modelSnap.providerName ?? "",
          inputRate: modelSnap.inputRate,
          outputRate: modelSnap.outputRate,
        }
      : undefined;
    // effectiveThresholdPct: the live fire point as a % of the window (null for
    // `custom`, which has no tierPct). Used by armed/ready + the dashboard.
    const effectiveThresholdPct = this.config.tierPct != null ? this.config.tierPct * 100 : null;
    // armed lights at/above the REAL fire point: max(effectiveThresholdPct,
    // fastGatePct). fastGatePct already equals tierPct*100 by default, but a
    // MEGACOMPACT_FAST_GATE_PCT override can raise it, so we take the max.
    const armed = this.lastCtxPercent != null && this.lastCtxPercent >= Math.max(effectiveThresholdPct ?? 0, this.config.fastGatePct);
    const ready = armed && (this.lastCtxTokens ?? 0) >= this.effectiveThreshold;
    this.dashboard.snapshot({
      version: 1,
      updatedAt: new Date().toISOString(),
      // S24: the headline tier is the LIVE pressure band; the env preset is kept
      // alongside as presetTier so the dashboard can show both.
      tier: this.pressureBand,
      presetTier: this.config.tier,
      pressure: this.pressure,
      config: {
        fastGatePct: this.config.fastGatePct,
        thresholdTokens: this.effectiveThreshold,
        tierPct: this.config.tierPct,
        effectiveThresholdPct,
        anchorUserMessages: this.config.anchorUserMessages,
        preserveRecent: this.config.preserveRecent,
        auto: this.config.auto,
        autoInline: this.config.autoInline,
      },
      session: {
        id: this.rt.sessionId,
        state: this.statusKey ?? "idle",
        persistedThisSession: this.rt.persistedThisSession,
        lastCheckpointId: this.rt.lastCheckpointId ?? null,
        lastCompactedFrom: this.rt.lastCompactedFrom,
        lastCompactedTokens: this.rt.lastCompactedTokens,
        dedupSkips: this.rt.dedupSkips,
        dedupAttempts: this.rt.dedupAttempts,
      },
      context: { tokens: this.lastCtxTokens, percent: this.lastCtxPercent, contextWindow: this.lastCtxWindow },
      trigger: { armed, ready, currentTokens: this.lastCtxTokens, thresholdTokens: this.effectiveThreshold, fastGatePct: this.config.fastGatePct, tierPct: this.config.tierPct, effectiveThresholdPct },
      crew: { activeAgents: this.activeAgents, currentTurn: this.currentTurn },
      store: { checkpointCount: st.checkpointCount, totalTokenEstimate: st.totalTokenEstimate, originalTokens: st.originalTokens, tokensSaved: this.rt.tokensSaved, injectedCount: st.injectedCount, dedupHitRate: st.dedupHitRate, storageDedupRate: st.storageDedupRate, dedupAttempts: st.dedupAttempts, dedupCollapsed: st.dedupCollapsed },
      // Reconciled token accounting (single canonical formula, session + repo).
      // Freed = In − Out; In = Freed + Out. session.Freed = rt.tokensSaved (incl.
      // deduped-away originals); repo.Freed = repo.tokensSaved meta counter.
      compression: {
        session: {
          tokensIn: this.rt.tokensSaved + st.totalTokenEstimate,
          tokensOut: st.totalTokenEstimate,
          tokensFreed: this.rt.tokensSaved,
          compressionPct: (this.rt.tokensSaved + st.totalTokenEstimate) > 0 ? this.rt.tokensSaved / (this.rt.tokensSaved + st.totalTokenEstimate) : 0,
          dedupPct: st.storageDedupRate,
        },
        repo: {
          tokensIn: repo.tokensSaved + repo.totalTokenEstimate,
          tokensOut: repo.totalTokenEstimate,
          tokensFreed: repo.tokensSaved,
          compressionPct: (repo.tokensSaved + repo.totalTokenEstimate) > 0 ? repo.tokensSaved / (repo.tokensSaved + repo.totalTokenEstimate) : 0,
          dedupPct: repo.storageDedupRate,
        },
      },
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
      integrity: {
        regionsRetained: di.regionsRetained,
        compressedOriginalBytes: di.compressedOriginalBytes,
        duplicatesCollapsed: di.duplicatesCollapsed,
        bytesPermanentlyDeleted: di.bytesPermanentlyDeleted,
      },
      model,
    } as DashboardSnapshot);

    // Live stats widget above the editor
    if (ctx) {
      const tokStr = this.lastCtxTokens != null ? `${Math.round(this.lastCtxTokens / 1000)}k` : "?";
      const maxStr = this.lastCtxWindow > 0 ? `${Math.round(this.lastCtxWindow / 1000)}k` : "?";
      const pctStr = this.lastCtxPercent != null ? `${Math.round(this.lastCtxPercent * 10) / 10}%` : "?%";
      // S24: the tier label is the LIVE pressure band (low/medium/high/ultra/
      // mega), not the static env preset. It climbs as context fills, so the
      // user can see the system react. The base preset is shown as a dim suffix.
      const liveBand = this.pressureBand;
      const tierLabel = `${C.bold}${liveBand}${C.reset}${C.gray}·${this.config.tier}${C.reset}`;
      const triggerLabel = ready ? `${C.green}● ready${C.reset}` : armed ? `${C.amber}◐ armed${C.reset}` : `${C.gray}○ idle${C.reset}`;
      // Storage dedup rate is cumulative (store-wide, per-repo) and survives
      // session resets. Always show a number: 0% before any compaction, a
      // decimal for sub-10% rates so small-but-real dedup isn't rounded away.
      const storageRate = st.storageDedupRate; // 0..1
      const dedupStr = storageRate * 100 >= 10
        ? `${Math.round(storageRate * 100)}%`
        : `${(storageRate * 100).toFixed(1)}%`;
      // Reconciled token accounting — ONE canonical formula for session + repo,
      // matching the dashboard so the two never disagree. unit format: M at/above
      // 1e6, k at/above 1e3, raw below — so 5,472,700 → "5.5M", 24,100 → "24.1k",
      // 142 → "142". Dropped (in) = Freed + Kept; Freed = rt.tokensSaved (session)
      // / repo.tokensSaved meta (repo); Kept = totalTokenEstimate (stored).
      const fmt = (x: number) =>
        x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}mil`
        : x >= 1000 ? `${(x / 1000).toFixed(1)}k`
        : `${Math.round(x)}`;
      // Agents view: ALWAYS show the agent line so status is visible even when
      // idle (previously hidden at 0). 🤖 N agents when active, dimmed 🤖 idle
      // when none — this is the restored "agents view" (count + status). Real
      // per-agent/sub-agent token usage is scoped in Sprint 27.
      const agentLabel = this.activeAgents > 0
        ? `🤖 ${this.activeAgents} agent${this.activeAgents === 1 ? "" : "s"}`
        : `${C.dim}🤖 idle${C.reset}`;
      const agentStr = ` │ ${agentLabel}`;
      const turnStr = this.currentTurn > 0 ? ` │ turn ${this.currentTurn}` : "";
      // Phase 3 — pulsing status glyph while a compaction is in flight.
      const pulse = this.pulsing ? `${C.cyan}${PULSE[Math.floor(Date.now() / 250) % PULSE.length]}${C.reset} ` : "";
      // --- reconciled in/out view (session + repo) ---------------------------
      const sessIn = this.rt.tokensSaved + st.totalTokenEstimate;
      const sessKept = st.totalTokenEstimate;
      const sessFreed = this.rt.tokensSaved;
      const sessPct = sessIn > 0 ? sessFreed / sessIn : 0;
      const repoIn = repo.tokensSaved + repo.totalTokenEstimate;
      const repoKept = repo.totalTokenEstimate;
      const repoFreed = repo.tokensSaved;
      const repoPct = repoIn > 0 ? repoFreed / repoIn : 0;
      // Retro gradient bar — `w` cells, each shaded by fill position so it
      // reads as a smooth green→amber→red ramp. Used for CONTEXT fill where
      // low=green (room to spare) and high=red (near the limit) — the only
      // live-moving metric worth a bar. Savings ratios saturate near 100% and
      // are shown as explanatory numbers instead (see L2).
      const ramp = (pct: number, w = 12): string => {
        const cells = ["▏","▎","▍","▌","▋","▊","▉","█"];
        const scaled = Math.max(0, Math.min(w, pct * w));
        const full = Math.floor(scaled);
        const frac = scaled - full;
        const fracCell = frac > 0 ? cells[Math.round(frac * (cells.length - 1))] : "";
        let out = "";
        for (let i = 0; i < full; i++) out += (i / w < 0.6 ? C.green : i / w < 0.85 ? C.amber : C.red) + "█";
        if (fracCell) out += (full / w < 0.6 ? C.green : full / w < 0.85 ? C.amber : C.red) + fracCell;
        out += C.dim + "░".repeat(Math.max(0, w - full - (fracCell ? 1 : 0))) + C.reset;
        return out;
      };
      const ctxPct = this.lastCtxPercent != null ? this.lastCtxPercent / 100 : 0;
      const sTxt = (sessPct * 100).toFixed(sessPct * 100 >= 10 ? 0 : 1);
      const rTxt = (repoPct * 100).toFixed(repoPct * 100 >= 10 ? 0 : 1);
      // Full-width panel: read the real terminal width and pad each line with a
      // panel background so the above-editor widget reads as a full-width status
      // bar. pi's widget renderer does not pass width to setWidget(), so we pad
      // ourselves. Falls back to 200 cols when stdout.columns is unavailable.
      const W = process.stdout?.columns ?? 200;
      const lines = [
        // top border — full-width hairline
        panelBar(W, "─"),
        // L1 — header: tier + ctx-fill bar (20-cell, green=room→red=full) +
        // tokens + status glyph + checkpoints + agents/turn. The context bar is
        // the only live-moving bar; the whole block is padded to full width.
        panelLine(` ${C.amber}⚡ ${tierLabel}${C.reset} v${C.bold}${ownVersion()}${C.reset} ${ramp(ctxPct, 20)} ${C.bold}${pctStr}${C.reset} ${tokStr}/${maxStr} │ ${triggerLabel} │ ${st.checkpointCount} chk${agentStr}${turnStr}`, W),
        // L2 — savings EXPLAINED, not bar'd. The freed/(freed+kept) ratio
        // saturates near 100% once cumulative freed dwarfs live kept, so a bar
        // is visually useless; show the compaction story instead.
        panelLine(`   ${C.magenta}dup ${dedupStr}${C.reset} │ ${C.gray}sess${C.reset} ${fmt(sessIn)}→${fmt(sessKept)} kept ${C.green}(${sTxt}% freed)${C.reset} · ${C.gray}all-time${C.reset} ${fmt(repoIn)}→${fmt(repoKept)} kept ${C.blue}(${rTxt}% freed)${C.reset} │ ${repo.checkpointCount} chk/${repo.sessionCount} sess`, W),
      ];
      // Live "now processing" line + why + recent deduped/compacted events,
      // collapsed to ONE rotating line (fresh only); padded to full width.
      const fresh = Date.now() - this.lastActivityAt < 4000;
      if (this.tierTrace && fresh) {
        lines.push(panelLine(`   ${pulse}${this.tierTrace}`, W));
      } else if (this.ticker.length > 0) {
        const step = Math.floor(Date.now() / 250);
        const idx = this.ticker.length - 1 - (step % this.ticker.length);
        const head = this.ticker[idx].text;
        const why = this.lastWhy ? ` ${C.gray}· ${this.lastWhy}${C.reset}` : "";
        const more = this.ticker.length > 1 ? ` ${C.dim}(+${this.ticker.length - 1} more)${C.reset}` : "";
        lines.push(panelLine(`   ${fresh ? C.teal : C.dim}${head}${why}${more}${C.reset}`, W));
      } else if (this.pulsing) {
        lines.push(panelLine(`   ${pulse}${C.teal}compacting…${C.reset}`, W));
      }
      // bottom border — full-width hairline closes the panel
      lines.push(panelBar(W, "─"));
      // (Accounting folded into L2's "in→kept (X% freed)" framing — freed =
      //  in − kept is implied, and the saturated-ratio bars are gone.)
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    }
  }

  setStatus(ctx: ExtensionContext, text: string | undefined): void {
    this.statusKey = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  resetRuntime(sessionId: string | undefined): void {
    const sid = normalizeSessionId(sessionId);
    if (this.rt.sessionId === sid && this.rt.persistedThisSession) return; // same session, keep checkpoint memory
    this.rt = {
      sessionId: sid,
      persistedThisSession: false,
      lastCheckpointId: undefined,
      lastCompactedFrom: 0,
      lastCompactedTokens: 0,
      dedupSkips: 0,
      dedupAttempts: 0,
      tokensSaved: 0,
    };
    this.statusKey = undefined;
    this.activeAgents = 0;
    this.currentTurn = 0;
    this.lastActivityAt = 0;
    this.tierTrace = undefined;
    this.ticker.length = 0;
    this.pulsing = false;
    this.savedGoal = 50_000;
    this.lastWhy = undefined;
  }

  /**
   * Capture the active model/provider from ctx.model and persist it so cost
   * estimation + the dashboard can read real pricing. Cheap + idempotent-ish:
   * only writes a new row when the model id changes (models change rarely).
   */
  captureModel(ctx: ExtensionContext): void {
    const m = ctx.model;
    if (!m) { this.appendEvent("captureModel:no-model", { cwd: ctx.cwd }); return; }
    if (this.currentModel && this.currentModel.modelId === m.id && this.currentModel.provider === m.provider) return;
    let providerName: string | null = null;
    try { providerName = ctx.modelRegistry?.getProviderDisplayName(m.provider) ?? null; } catch { /* optional */ }
    const snap: Omit<ModelSnapshot, "capturedAt"> = {
      provider: m.provider,
      providerName,
      modelId: m.id,
      modelName: m.name ?? null,
      inputRate: m.cost?.input ?? 0,
      outputRate: m.cost?.output ?? 0,
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      reasoning: !!m.reasoning,
    };
    this.currentModel = { ...snap, capturedAt: Date.now() };
    this.diagCaptureModelCalls++;
    const repo = resolveRepoRoot(ctx.cwd) ?? this.currentStateDir;
    // S26: previously a single silent `catch {}` hid every capture failure, so
    // model_snapshots stayed empty and the cost card read $0.00 with zero signal.
    // Split per-write + append to events.log (always-on, dashboard live-streams
    // it) + bump a DIAG counter so a live capture surfaces the root cause.
    try {
      recordModelSnapshot(repo, snap, this.currentStateDir);
      this.appendEvent("captureModel:recorded", {
        repo, modelId: snap.modelId, provider: snap.provider,
        inputRate: snap.inputRate, outputRate: snap.outputRate,
      });
    } catch (e) {
      this.diagCaptureModelFails++;
      this.appendEvent("captureModel:record-failed", {
        repo, modelId: snap.modelId,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
    try {
      // Denormalize the active model into the machine-wide index so the
      // All-repos dashboard table can show provider/model per repo without
      // opening every repo's DB. Best-effort + non-fatal.
      recordRepoModel(repo, {
        provider: snap.provider,
        providerName: snap.providerName,
        modelName: snap.modelName,
        inputRate: snap.inputRate,
        outputRate: snap.outputRate,
        stateDir: this.currentStateDir,
        displayName: repo.split(/[\\/]/).filter(Boolean).pop() ?? repo,
      });
    } catch (e) {
      this.appendEvent("captureModel:index-record-failed", {
        repo, modelId: snap.modelId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Append a structured line to the repo's events.log — the always-on
   * diagnostics sink the dashboard live-streams. Unlike this.logger (gated by
   * config.debug), this fires in production, so capture failures surface during
   * a real capture even with debugging off. Best-effort + non-fatal.
   */
  private appendEvent(event: string, fields: Record<string, unknown>): void {
    try {
      mkdirSync(this.currentStateDir, { recursive: true });
      appendFileSync(join(this.currentStateDir, "events.log"), JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n");
    } catch { /* non-fatal */ }
  }

  /** S21: state dir of the currently bound repo (where memories live). */
  getStateDir(): string {
    return this.currentStateDir;
  }

  /** Build the sync onTier callback that paints the live per-tier trace. */
  makeTierCallback(ctx: ExtensionContext): (ev: { tier: "L0" | "L1" | "L2" | "new"; status: "scanning" | "deduped" | "passed" | "stored"; detail?: string }) => void {
    const order: Array<"L0" | "L1" | "L2" | "new"> = ["L0", "L1", "L2", "new"];
    const seen = new Map<string, string>();
    const glyph = (status: string) =>
      status === "deduped" ? `${C.green}✓${C.reset}` :
        status === "passed" ? `${C.dim}○${C.reset}` :
          status === "scanning" ? `${C.amber}…${C.reset}` :
            `${C.cyan}●${C.reset}`;
    return (ev) => {
      const label =
        ev.tier === "new"
          ? `${C.cyan}stored${C.reset}`
          : `${ev.tier} ${glyph(ev.status)}` +
            (ev.detail ? ` ${C.gray}(${ev.detail})${C.reset}` : "");
      // Show the most recent outcome per tier (collapses re-fires).
      seen.set(ev.tier, label);
      const show: string[] = [];
      for (const t of order) if (seen.has(t)) show.push(seen.get(t)!);
      this.tierTrace = `${C.teal}⚙${C.reset} ${show.join(` ${C.gray}→${C.reset} `)}`;
      this.lastActivityAt = Date.now();
      try { this.snapshot(ctx); } catch { /* non-fatal */ }
    };
  }

  // Phase 3 — recall/activity ticker ring buffer.
  pushTicker(text: string): void {
    this.ticker.push({ text, at: Date.now() });
    while (this.ticker.length > this.TICKER_MAX) this.ticker.shift();
    this.lastActivityAt = Date.now();
  }

  /** Convert the messages pi hands us in the `context` event into the engine view. */
  engineView(messages: AgentMessage[]): ReturnType<typeof toEngineMessages> {
    return toEngineMessages(messages);
  }
}

/**
 * Latest user message text — used as the auto-inline recall query.
 * Kept as a free function (not instance state) since it only reads ctx.
 */
export function recentUserQuery(ctx: ExtensionContext): string {
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
