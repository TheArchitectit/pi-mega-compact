/**
 * mega-commands/dataCommands.ts — the data/inspection slash commands (data group).
 *
 * Extracted from mega-commands.ts (delegate-shell split). Registers
 * /mega-compact, /mega-recall, and /mega-status.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { normalizeSessionId } from "../../src/store.js";
import { latestModelSnapshot, countInjectedGlobal, listRepoRegistry } from "../../src/store/sqlite.js";
import { loadMetrics, fpRate, p95, defaultMetricsPath } from "../../src/monitoring.js";
import { type MegaRuntime, C, recentUserQuery } from "../mega-runtime.js";
import { runCompact, doRecall, doRecallAsync } from "../mega-pipeline.js";
import { vectorStats, vectorRepoStats, vectorDataInvariant } from "../../src/vectorStore.js";
import type { MegaConfig } from "../mega-config.js";

/** Register the data/inspection commands (data group). */
export function registerDataCommands(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	pi.registerCommand("mega-compact", {
		description: "Compress current session context into the local vector store.",
		handler: async (args: string, ctx: ExtensionContext) => {
		 try {
		  const sessionEntries = ctx.sessionManager.getEntries();
		  // Project entries (branch-aware) into the message view.
		  const messages = sessionEntries.flatMap((e) => sessionEntryToContextMessages(e));
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
		 } catch (e) {
		   ctx.ui.notify(`[mega-compact] /mega-compact failed: ${String(e)}`);
		 }
		},
	});

	pi.registerCommand("mega-recall", {
		description: "Recall relevant compacted context from the vector store and inline it. Use --cross-repo to search all repos.",
		handler: async (args: string, ctx: ExtensionContext) => {
		 try {
		  // S17: --cross-repo (or --cross repo) runs the async path over every repo's
		  // PGlite HNSW index (stricter cosine floor + source labels).
		  const crossRepo = /--cross[- ]repo\b/.test(args);
		  const query = args.replace(/--cross[- ]repo\b/, "").trim() || recentUserQuery(ctx);
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
		      `(injected at the tail of the next turn's context)`,
		  );
		 } catch (e) {
		   ctx.ui.notify(`[mega-compact] /mega-recall failed: ${String(e)}`);
		 }
		},
	});

	pi.registerCommand("mega-status", {
		description: "Show mega-compact config, context usage, and the data-safety invariant.",
		handler: async (_args: string, ctx: ExtensionContext) => {
		 try {
		  runtime.bindRepo(ctx.cwd);
		  const usage = ctx.getContextUsage();
		  const pct = usage?.percent != null ? `${usage.percent}%` : "n/a";
		  const tokens = usage?.tokens != null ? `${usage.tokens} tok` : "n/a";
		  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
		  const st = vectorStats(runtime.store, sid);
		  const repo = vectorRepoStats(runtime.store);
		  const di = vectorDataInvariant(runtime.store);
		  const fmtB = (b: number) =>
		    b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MiB` :
		      b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`;
		  // Real cost: tokens saved × the captured model's input rate (USD/token),
		  // read from the model_snapshots table (Phase 5b schema). Falls back to 0
		  // when no model has been captured yet. contextWindow ÷ savedRate = context
		  // windows extended (how much "extra" conversation the freed space buys).
		  const model = latestModelSnapshot(runtime.currentStateDir);
		  const rate = model?.inputRate ?? 0;
		  const usd = ((repo.tokensSaved ?? 0) * rate).toFixed(4);
		  const ctxWindow = usage?.contextWindow ?? 0;
		  const daysExtended = ctxWindow > 0 && repo.tokensSaved > 0
		    ? (repo.tokensSaved / ctxWindow).toFixed(1)
		    : "0";
		  // Identified model/provider (captured on model_select / session_start).
		  // Shows the human model name + provider so the user knows WHICH model's
		  // pricing drives the cost figure. Falls back when none captured yet.
		  const modelStr = model
		    ? `${model.modelName ?? model.modelId ?? "?"} · ${model.providerName ?? model.provider ?? "?"}`
		    : "unknown (no model captured)";
		  const costStr = `≈ $${usd} saved · ${daysExtended} context-windows extended`;
		  // Recall-quality badge (Phase 4): trust score from monitoring metrics.
		  // H1 fix: loadMetrics expects a *file* path (dashboard.json), not the
		  // state dir — passing the dir made existsSync() true (dirs exist) then
		  // readFileSync() threw EISDIR, silently caught → metrics always zero.
		  const m = loadMetrics(defaultMetricsPath(runtime.currentStateDir));
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
		 } catch (e) {
		   ctx.ui.notify(`[mega-compact] /mega-status error: ${String(e)}`);
		 }
		},
	});
}
