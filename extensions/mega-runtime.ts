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
import { readFileSync } from "node:fs";
import { VectorStore } from "../src/vectorStore.js";
import { toEngineMessages } from "../src/adapt.js";
import { normalizeSessionId } from "../src/store.js";
import { Logger } from "../src/log.js";
import { recordModelSnapshot, latestModelSnapshot, upsertRepoRegistry, recordRepoModel, type ModelSnapshot } from "../src/store/sqlite.js";
import { repoStateDir, resolveRepoRoot, pressureRatio, pressureFromPct, pressureBand, type MegaConfig, type PressureBand } from "./mega-config.js";
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
   * Live 0–1 pressure: how full the context window is relative to the compaction
   * threshold. Computed from the most recent context event the runtime already
   * tracks (token count when available — the direct signal — otherwise the usage
   * percentage). This is the single "how full" number every subsystem reads; the
   * toolbar/dashboard tier label is `pressureBand` over this, so it climbs
   * low→mega as context rises (S24). Always finite + in [0,1].
   */
  get pressure(): number {
    if (this.lastCtxTokens != null && this.lastCtxTokens > 0 && this.config.thresholdTokens > 0) {
      return pressureRatio(this.lastCtxTokens, this.config.thresholdTokens);
    }
    return pressureFromPct(this.lastCtxPercent);
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
    const armed = this.lastCtxPercent != null && this.lastCtxPercent >= this.config.fastGatePct;
    const ready = armed && (this.lastCtxTokens ?? 0) >= this.config.thresholdTokens;
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
        thresholdTokens: this.config.thresholdTokens,
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
      trigger: { armed, ready, currentTokens: this.lastCtxTokens, thresholdTokens: this.config.thresholdTokens, fastGatePct: this.config.fastGatePct },
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
      const agentStr = this.activeAgents > 0 ? ` │ 🤖 ${this.activeAgents} agent${this.activeAgents === 1 ? "" : "s"}` : "";
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
      // Retro gradient bar — 12 cells, each cell shaded by fill so it reads as a
      // smooth green→amber→red ramp instead of a flat block. Higher fill = more
      // reclaimed, so the bar trends green at the right end.
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
      const lines = [
        // L1 — header: tier + ctx fill bar + tokens + checkpoints + agents
        ` ${C.amber}⚡ ${tierLabel}${C.reset} v${C.bold}${ownVersion()}${C.reset} ${ramp(ctxPct)} ${C.bold}${pctStr}${C.reset} ${tokStr}/${maxStr} │ ${st.checkpointCount} chk${agentStr}${turnStr}`,
        // L2 — status + dedup + session + all-time savings bars
        `   ${triggerLabel} ${C.magenta}dup ${dedupStr}${C.reset} ${C.gray}sess${C.reset} ${ramp(sessPct)} ${C.green}${sTxt}%${C.reset} ${C.gray}all-time${C.reset} ${ramp(repoPct)} ${C.blue}${rTxt}%${C.reset}`,
      ];
      // Live "now processing" line + why + recent deduped/compacted events,
      // collapsed to ONE rotating line (fresh only). The ticker ring buffer
      // (≤5 most-recent events) is cycled one-per-repaint so the line scrolls
      // through recent files in real time while activity fires. We rotate on a
      // 250ms step (same cadence as the pulse), using an event counter as the
      // deterministic phase so consecutive repaints advance the visible entry.
      const fresh = Date.now() - this.lastActivityAt < 4000;
      if (this.tierTrace && fresh) {
        lines.push(`   ${pulse}${this.tierTrace}`);
      } else if (this.ticker.length > 0) {
        const step = Math.floor(Date.now() / 250);
        const idx = this.ticker.length - 1 - (step % this.ticker.length);
        const head = this.ticker[idx].text;
        const why = this.lastWhy ? ` ${C.gray}· ${this.lastWhy}${C.reset}` : "";
        const more = this.ticker.length > 1 ? ` ${C.dim}(+${this.ticker.length - 1} more)${C.reset}` : "";
        lines.push(`   ${fresh ? C.teal : C.dim}${head}${why}${more}${C.reset}`);
      } else if (this.pulsing) {
        lines.push(`   ${pulse}${C.teal}compacting…${C.reset}`);
      }
      // L4 — accounting: session + all-time in/out/freed, one compact line.
      // in = dropped into compaction, out = kept summaries, freed = saved.
      if (lines.length < 10) {
        lines.push(`   ${C.dim}session ↑${fmt(sessIn)} in ↓${fmt(sessKept)} out ↓${fmt(sessFreed)} freed · all-time ↑${fmt(repoIn)} in ↓${fmt(repoKept)} out ↓${fmt(repoFreed)} freed${C.reset}`);
      }
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
    if (!m) return;
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
    try {
      const repo = resolveRepoRoot(ctx.cwd) ?? this.currentStateDir;
      recordModelSnapshot(repo, snap, this.currentStateDir);
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
    } catch { /* non-fatal: cost estimation degrades to model-in-memory only */ }
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
