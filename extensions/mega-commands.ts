/**
 * mega-commands.ts — the data/inspection slash commands.
 *
 * Registers the 8 user-facing commands that operate on the local vector store
 * and live runtime state. The cost estimate in /mega-status now uses the real
 * captured model rate (model_snapshots in SQLite) instead of a $3/1M stub.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { normalizeSessionId } from "../src/store.js";
import { listCheckpoints, latestModelSnapshot, countInjectedGlobal, listRepoRegistry } from "../src/store/sqlite.js";
import { decompressSmart } from "../src/store/compression.js";
import { loadMetrics, fpRate, p95 } from "../src/monitoring.js";
import { MegaRuntime, C, recentUserQuery } from "./mega-runtime.js";
import { runCompact, doRecall, doRecallAsync } from "./mega-pipeline.js";
import { type MegaConfig } from "./mega-config.js";

/** Resolve a checkpoint by id (or "recent"/"last") from this session's store. */
export function findCheckpoint(runtime: MegaRuntime, sid: string, ref: string) {
  const all = listCheckpoints(sid, runtime.currentStateDir);
  if (all.length === 0) return undefined;
  if (!ref || ref === "recent" || ref === "last") return all[all.length - 1];
  return all.find((c) => c.checkpointId === ref) ?? all.find((c) => c.checkpointId.endsWith(ref));
}

/** Register all data/inspection commands. */
export function registerCommands(pi: ExtensionAPI, runtime: MegaRuntime, config: MegaConfig): void {
  pi.registerCommand("mega-compact", {
    description: "Compress current session context into the local vector store.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sessionEntries = ctx.sessionManager.getEntries();
      // Project entries (branch-aware) into the message view.
      const messages: any[] = sessionEntries.flatMap((e) => sessionEntryToContextMessages(e));
      const summaryArg = args.trim();
      const ran = runCompact(pi, runtime, config, ctx, messages, summaryArg ? { summary: summaryArg } : {});
      if ("skipped" in ran && ran.skipped) {
        ctx.ui.notify("[mega-compact] Nothing to compact (session too small).");
        return;
      }
      const r = (ran as { result: { deduped: boolean; checkpointId?: string; tokenEstimate: number } }).result;
      ctx.ui.notify(
        `[mega-compact] ${r.deduped ? "region already compacted (deduped)" : `persisted ${r.checkpointId}`} · ` +
          `${r.tokenEstimate} tok · ${runtime.currentStateDir}`,
      );
    },
  });

  pi.registerCommand("mega-recall", {
    description: "Recall relevant compacted context from the vector store and inline it. Use --cross-repo to search all repos.",
    handler: async (args: string, ctx: ExtensionContext) => {
      // S17: --cross-repo (or --cross repo) runs the async path over every repo's
      // PGlite HNSW index (stricter cosine floor + source labels).
      const crossRepo = /\-\-cross[\- ]repo\b/.test(args);
      const query = args.replace(/--cross[\- ]repo\b/, "").trim() || recentUserQuery(ctx);
      if (!query) {
        ctx.ui.notify("[mega-compact] /mega-recall needs a query or a prior user message.");
        return;
      }
      const r = crossRepo
        ? await doRecallAsync(runtime, config, ctx, query, "command", { crossRepo: true })
        : doRecall(runtime, config, ctx, query, "command");
      if (r.empty) {
        runtime.logger.info("recall-empty", { query, crossRepo });
        ctx.ui.notify(`[mega-compact] recall found nothing new for "${query}".`);
        return;
      }
      // Stage the block so the next before_agent_start prepends it (actual
      // injection). Report what was selected now for immediate feedback.
      runtime.pendingRecallBlock = r.block;
      const list = r.report.map((l) => l).join("\n");
      runtime.logger.info("recall", { query, crossRepo, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
      runtime.setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt${crossRepo ? " (cross-repo)" : ""}`);
      ctx.ui.notify(
        `[mega-compact] recall staged ${r.toInject.length} checkpoint(s) for "${query}"${crossRepo ? " (cross-repo)" : ""}:\n${list}\n` +
          `(injected at the next turn via system prompt)`,
      );
    },
  });

  pi.registerCommand("mega-status", {
    description: "Show mega-compact config, context usage, and the data-safety invariant.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      const usage = ctx.getContextUsage();
      const pct = usage?.percent != null ? `${usage.percent}%` : "n/a";
      const tokens = usage?.tokens != null ? `${usage.tokens} tok` : "n/a";
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const st = runtime.store.stats(sid);
      const repo = runtime.store.repoStats();
      const di = runtime.store.dataInvariant();
      const fmtB = (b: number) =>
        b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MiB` :
          b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`;
      // Real cost: tokens saved × the captured model's input rate (USD/token),
      // read from the model_snapshots table (Phase 5b schema). Falls back to 0
      // when no model has been captured yet. contextWindow ÷ savedRate = context
      // windows extended (how much "extra" conversation the freed space buys).
      const model = latestModelSnapshot(runtime.currentStateDir);
      const rate = model?.inputRate ?? 0;
      const usd = (repo.tokensSaved * rate).toFixed(4);
      const ctxWindow = usage?.contextWindow ?? 0;
      const daysExtended = ctxWindow > 0 && repo.tokensSaved > 0
        ? (repo.tokensSaved / ctxWindow).toFixed(1)
        : "0";
      // Identified model/provider (captured on model_select / session_start).
      // Shows the human model name + provider so the user knows WHICH model's
      // pricing drives the cost figure. Falls back when none captured yet.
      const modelStr = model
        ? `${model.modelName ?? model.modelId} · ${model.providerName ?? model.provider}`
        : "unknown (no model captured)";
      const costStr = `≈ $${usd} saved · ${daysExtended} context-windows extended`;
      // Recall-quality badge (Phase 4): trust score from monitoring metrics.
      const m = loadMetrics(runtime.currentStateDir);
      const fp = fpRate(m, "L2");
      const p95L2 = p95(m.latency.L2 ?? []);
      const relPct = (st.dedupHitRate * 100).toFixed(0);
      const qualityStr = `recall ${relPct}% relevant · FP ${(fp * 100).toFixed(1)}% · L2 p95 ${p95L2.toFixed(0)}ms`;
      // S18: cross-repo stats from the machine-wide index (best-effort; the
      // index dir may be unset → 0/empty, never throws).
      let crossRepoInjections = 0;
      let repoCount = 0;
      try {
        crossRepoInjections = countInjectedGlobal(process.env.MEGACOMPACT_INDEX_DIR);
        repoCount = listRepoRegistry(process.env.MEGACOMPACT_INDEX_DIR).length;
      } catch { /* non-fatal */ }
      const crossRepoStr = `${crossRepoInjections} cross-repo injections recorded · ${repoCount} repos indexed`;
      // Effective compaction threshold = tierPct × model context window (kept
      // BELOW pi's native ~80% auto-compact for any model size). Falls back to
      // the boot token value when the window is unknown (custom tier / pre-
      // model-select). Display matches the dashboard's percentage-based view.
      const effThreshold = config.tierPct != null && ctxWindow > 0
        ? Math.round(config.tierPct * ctxWindow)
        : config.thresholdTokens;
      const winStr = ctxWindow > 0
        ? (ctxWindow >= 1_000_000 ? `${Math.round(ctxWindow / 1_000_000)}M` : `${Math.round(ctxWindow / 1_000)}k`)
        : "?";
      const tierPctStr = config.tierPct != null ? `${Math.round(config.tierPct * 100)}%` : "n/a";
      ctx.ui.notify(
        `[mega-compact] pct=${pct} tokens=${tokens} tier=${runtime.pressureBand} (live) preset=${config.tier} ` +
          `pressure=${Math.round(runtime.pressure * 100)}% fastGate=${config.fastGatePct}% ` +
          `threshold=${effThreshold.toLocaleString()} (${tierPctStr} of ${winStr} window) tierPct=${config.tierPct != null ? config.tierPct.toFixed(2) : "n/a"} auto=${config.auto} autoInline=${config.autoInline}\n` +
          `[mega-compact] store: ${st.checkpointCount} chkpt · ` +
          `${st.totalTokenEstimate} tok · last=${st.lastCheckpointId ?? "—"} · ` +
          `injected=${st.injectedCount} · dedup=${(st.dedupHitRate * 100).toFixed(0)}%\n` +
          `[mega-compact] anchor=${config.anchorUserMessages} preserveRecent=${config.preserveRecent} ` +
          `autoInlineK=${config.autoInlineK} dedupSim=${config.dedupSim} debug=${config.debug}\n` +
          `[mega-compact] 🛡 data-safe: ${di.regionsRetained} regions retained ` +
          `(${fmtB(di.compressedOriginalBytes)} compressed-original) · ` +
          `${di.duplicatesCollapsed} dedup-duplicates collapsed · ` +
          `${C.green}0 bytes permanently deleted${C.reset}\n` +
          `[mega-compact] 💰 ${costStr}\n` +
          `[mega-compact] 🤖 model: ${modelStr}\n` +
          `[mega-compact] 🎯 ${qualityStr}\n` +
          `[mega-compact] 🌐 ${crossRepoStr}\n` +
          `[mega-compact] stateDir=${runtime.currentStateDir}`,
      );
    },
  });

  // ---- Phase 4: cheap standout commands (data is already persisted) -------

  pi.registerCommand("mega-restore", {
    description: "Re-inject a checkpoint's verbatim original region into context. Usage: /mega-restore <chkpt|recent>",
    handler: async (args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const cp = findCheckpoint(runtime, sid, args.trim());
      if (!cp) {
        ctx.ui.notify(`[mega-compact] no checkpoint found${args.trim() ? ` for "${args.trim()}"` : ""} in this session. Try /mega-history.`);
        return;
      }
      if (!cp.compressedOriginal) {
        ctx.ui.notify(`[mega-compact] ${cp.checkpointId} has no recoverable original (pre-blob or direct add). Cannot restore verbatim.`);
        return;
      }
      const original = decompressSmart(cp.compressedOriginal).toString("utf-8");
      // Re-inject verbatim via before_agent_start (PREVENT-PI-003) — never
      // touches live messages, only prepends the restored region to systemPrompt.
      runtime.pendingRecallBlock = `The following compacted context was RESTORED from checkpoint ${cp.checkpointId} (verbatim original region):\n\n${original}`;
      const files = cp.filesModified?.length ? cp.filesModified.join(", ") : "(no files captured)";
      ctx.ui.notify(
        `[mega-compact] ♻ restored ${cp.checkpointId} — ${original.length} chars re-injected on next turn.\n` +
        `[mega-compact] files: ${files}`,
      );
      runtime.dashboard.event("restore", { checkpointId: cp.checkpointId, chars: original.length });
    },
  });

  pi.registerCommand("mega-history", {
    description: "List this session's checkpoints (id, date, files, tokens). Usage: /mega-history",
    handler: async (_args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const all = listCheckpoints(sid, runtime.currentStateDir);
      if (all.length === 0) {
        ctx.ui.notify("[mega-compact] no checkpoints in this session yet.");
        return;
      }
      const rows = all.map((c) => {
        const when = c.timestamp ? new Date(c.timestamp).toISOString().slice(0, 16).replace("T", " ") : "—";
        const files = c.filesModified?.length ? c.filesModified.map((f) => f.split("/").pop()).join(", ") : "—";
        const orig = c.originalTokenEstimate ?? 0;
        const stored = c.tokenEstimate ?? 0;
        const saved = Math.max(0, orig - stored);
        return `  ${c.checkpointId}  ${when}  ${C.cyan}${saved}t saved${C.reset}  ${files}`;
      });
      ctx.ui.notify(
        `[mega-compact] ${all.length} checkpoint(s) in this session:\n` + rows.join("\n") +
        `\n[mega-compact] /mega-view <chkpt> to see the original region · /mega-restore <chkpt> to re-inject it`,
      );
    },
  });

  pi.registerCommand("mega-view", {
    description: "Show a checkpoint's verbatim original region. Usage: /mega-view <chkpt|recent>",
    handler: async (args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const cp = findCheckpoint(runtime, sid, args.trim());
      if (!cp) {
        ctx.ui.notify(`[mega-compact] no checkpoint found${args.trim() ? ` for "${args.trim()}"` : ""}. Try /mega-history.`);
        return;
      }
      if (!cp.compressedOriginal) {
        ctx.ui.notify(`[mega-compact] ${cp.checkpointId} summary:\n${cp.summary.slice(0, 500)}${cp.summary.length > 500 ? "…" : ""}\n(no verbatim original stored)`);
        return;
      }
      const original = decompressSmart(cp.compressedOriginal).toString("utf-8");
      ctx.ui.notify(
        `[mega-compact] ${cp.checkpointId} — original region (${original.length} chars):\n` +
        `${original.slice(0, 1500)}${original.length > 1500 ? "\n…(truncated)" : ""}`,
      );
    },
  });

  pi.registerCommand("mega-help", {
    description: "Plain-language glossary of what mega-compact's stats mean.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      ctx.ui.notify(
        `[mega-compact] glossary — what the numbers mean:\n` +
        `• token — a chunk of text (~4 chars). Context window = how much text fits in memory at once.\n` +
        `• space freed — how much conversation we've compressed away to make room (the win).\n` +
        `• memory held — how much compact summary we're currently keeping as your 'notes'.\n` +
        `• saved checkpoint — a compact summary of an old conversation chunk we stored.\n` +
        `• repeat-skipped — how often new text matched something we already had, so we didn't store a duplicate.\n` +
        `• injected — times we pasted an old saved note back into the chat because it was relevant.\n` +
        `• recall relevance — of those, how often the note was actually on-topic.\n` +
        `• data safety — every compressed region is kept verbatim; nothing is permanently deleted. /mega-restore brings any of it back.`,
      );
    },
  });

  // NOTE: /mega-tier was removed in S24. The tier the user sees is now the LIVE
  // pressure band (low/medium/high/ultra/mega), which climbs automatically as
  // context fills — there is no manual tier to set. See docs/specs/s24-unified-pressure.md.
}
