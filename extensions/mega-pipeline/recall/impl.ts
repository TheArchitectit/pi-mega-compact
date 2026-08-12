/**
 * recall/impl.ts — unified Layer-5 recall pipeline implementation (3WF-3 split).
 *
 * Behavior is UNCHANGED from the pre-split recall.ts. `doRecall` is the ONE path
 * that injects (sync). `doRecallAsync` augments with optional cross-repo HNSW
 * on resume / /mega-recall --cross-repo. Both mutate the shared MegaRuntime
 * (token accounting, ticker, dashboard events). The shell recall.ts re-exports
 * these names so `export * from "./mega-pipeline/recall.js"` stays byte-stable.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	recallAndInline,
	recallAndInlineAsync,
	formatRecallBlock,
	type RecallInjectResult,
} from "../../../src/recall.js";
import { normalizeSessionId } from "../../../src/store.js";
import {
	incRecallInjected,
	incCacheHitTokens,
	getIndexDir,
} from "../../../src/store/sqlite.js";
import {
	ensureConversationIdFor,
	recordTurnWrite,
	recordRecallWrite,
} from "../../mega-turn-store.js";
import { type MegaRuntime, C } from "../../mega-runtime.js";
import { recordRecallLatency } from "../../mega-runtime/vc-observer.js";
import type { MegaConfig } from "../../mega-config.js";

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
	const recallStartMs = Date.now();
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
	runtime.dashboard.event("recall", {
		source,
		query: query.slice(0, 120),
		injected: result.toInject.length,
		empty: result.empty,
	});
	if (config.ragRecallMetrics && result.hydeInfo) {
		runtime.dashboard.event("hyde_executed", {
			sessionId: sid,
			ran: result.hydeInfo.ran,
			skipped: result.hydeInfo.skipped,
			reason: result.hydeInfo.reason,
			hypotheticalDoc: result.hydeInfo.hypotheticalDoc.slice(0, 400),
			generationMs: result.hydeInfo.generationMs,
			rawHitCount: result.hydeInfo.rawHitCount,
			hydeHitCount: result.hydeInfo.hydeHitCount,
			fusedHitCount: result.hydeInfo.fusedHitCount,
			lift: result.hydeInfo.lift,
		});
	}
	if (config.ragRecallMetrics && result.recallMetrics) {
		runtime.dashboard.event("recall_metrics", {
			sessionId: sid,
			hitCount: result.recallMetrics.hitCount,
			score: result.recallMetrics.score,
			pass: result.recallMetrics.pass,
			relevance: result.recallMetrics.relevance,
			coverage: result.recallMetrics.coverage,
			diversity: result.recallMetrics.diversity,
			specificity: result.recallMetrics.specificity,
		});
	}
	if (!result.empty && result.toInject.length > 0) {
		const top = result.toInject[0];
		const scorePct = Math.round((top.score ?? 0) * 100);
		const files = top.checkpoint.filesModified ?? [];
		const label = files.length
			? files
					.map((f) => f.split("/").pop() ?? f)
					.slice(0, 2)
					.join(", ")
			: top.checkpoint.checkpointId;
		runtime.pushTicker(
			`${C.amber}↩${C.reset} recalled ${top.checkpoint.checkpointId} · ${scorePct}% · ${label}`,
		);
		runtime.lastWhy = `why: recalled@${scorePct}% (${result.toInject.length} chkpt)`;
	}
	let sumTokens = 0;
	for (const h of result.toInject) sumTokens += h.checkpoint.tokenEstimate;
	if (result.toInject.length > 0) {
		runtime.rt.recallInjections += result.toInject.length;
		runtime.rt.cacheHitTokens += sumTokens;
		incRecallInjected(result.toInject.length, runtime.currentStateDir);
		incCacheHitTokens(sumTokens, runtime.currentStateDir);
	}
	// S43: record recall provenance — which checkpoints/summaries served this
	// turn, their score + source path. Linked to the turn row written at
	// turn_end via the conversation+turnIndex. Best-effort + non-fatal.
	// Persists telemetry (HyDE + recall metrics) even when recall returned
	// no hits, so empty-recall HyDE invocations are still visible in the
	// dashboard Turns/Metrics tabs.
	const hasTelemetry =
		result.hydeInfo != null || result.recallMetrics != null;
	if (result.toInject.length > 0 || hasTelemetry) {
		try {
			const convId = ensureConversationIdFor(
				config,
				sid,
				runtime.currentStateDir,
			);
			const turnId = recordTurnWrite(
				config,
				{
					conversationId: convId,
					sessionId: sid,
					turnIndex: runtime.currentTurn,
					role: "assistant",
					startedAt: Date.now(),
					hyde: result.hydeInfo ?? undefined,
					recallMetrics: result.recallMetrics ?? undefined,
				},
				runtime.currentStateDir,
			);
			if (result.toInject.length > 0) {
				recordRecallWrite(
					config,
					turnId,
					result.toInject.map((h) => ({
						checkpointId: h.checkpoint.checkpointId,
						score: h.score,
						source:
							h.raptorLevel !== undefined
								? "raptor"
								: h.repoId
									? "cross-repo"
									: "flat",
						raptorLevel: h.raptorLevel,
					})),
					runtime.currentStateDir,
				);
			}
		} catch {
			/* non-fatal: recall provenance never breaks the recall path */
		}
	}
	// VC0A: record recall latency on the eval observer (mode A) so the dashboard
	// histogram reflects real data. No-op when the observer is absent (flag off /
	// construction failure).
	try {
		recordRecallLatency(runtime, Date.now() - recallStartMs, sid, 0);
	} catch {
		/* non-fatal: latency recording never breaks recall */
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
	if (!config.crossRepoEnabled || !opts.crossRepo) return sameRepo;
	if (sameRepo.toInject.length >= config.autoInlineK) return sameRepo; // same-repo satisfied
	// Augment: cross-repo HNSW (async) with the stricter floor. Non-fatal.
	try {
		const x = await recallAndInlineAsync(
			{
				sessionId: sid,
				query,
				limit: config.autoInlineK,
				source,
				skipInjected: true,
				recallMaxTokens: config.recallMaxTokens,
				windowDedupe: config.windowDedupe,
				liveWindow,
				dedupSim: config.crossRepoCosine,
				crossRepo: true,
				// F2: resolve the machine-wide index dir via the shared resolver so the
				// cross-repo injected-set dedup works even when MEGACOMPACT_INDEX_DIR is
				// unset. The env var still wins when set (getIndexDir checks it first);
				// the default (~/.mega-compact-index) is the same DB mega-commands and the
				// dashboard read, so injection counts stay consistent. Without this, a
				// bare `process.env` read returns undefined → cross-repo hits re-inject in
				// every new session (the global injected-set is never consulted).
				globalIndexDir: getIndexDir(),
			},
			runtime.store,
		);
		runtime.dashboard.event("recall-crossrepo", {
			source,
			query: query.slice(0, 120),
			injected: x.toInject.length,
			sourceRepos: x.toInject.map((h) => h.repoId).filter(Boolean),
		});
		// Merge, dedup by checkpointId, respect the same token cap by reformatting.
		const seen = new Set(
			sameRepo.toInject.map((h) => h.checkpoint.checkpointId),
		);
		const merged = [...sameRepo.toInject];
		for (const h of x.toInject) {
			if (!seen.has(h.checkpoint.checkpointId)) {
				merged.push(h);
				seen.add(h.checkpoint.checkpointId);
			}
		}
		const block = merged.length ? formatRecallBlock(merged) : "";
		if (merged.length > 0) {
			let sumTokens = 0;
			for (const h of merged) sumTokens += h.checkpoint.tokenEstimate;
			runtime.rt.recallInjections += merged.length;
			runtime.rt.cacheHitTokens += sumTokens;
			incRecallInjected(merged.length, runtime.currentStateDir);
			incCacheHitTokens(sumTokens, runtime.currentStateDir);
		}
		return {
			toInject: merged,
			report: merged.map(
				(h) =>
					`  • ${h.checkpoint.checkpointId}${h.repoId ? ` (from ${h.repoId.split("/").filter(Boolean).pop()})` : ""}`,
			),
			block,
			empty: merged.length === 0,
			// H1: merged cross-repo result reuses the same-repo pass's telemetry.
			hydeInfo: sameRepo.hydeInfo,
			recallMetrics: sameRepo.recallMetrics,
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
export function extractLiveWindow(ctx: ExtensionContext): string[] {
	try {
		const entries = ctx.sessionManager.getEntries();
		const texts: string[] = [];
		for (const e of entries) {
			for (const m of sessionEntryToContextMessages(e)) {
				const c = (m as { content?: unknown }).content;
				if (typeof c === "string") texts.push(c);
				else if (Array.isArray(c))
					texts.push(c.map((b: { text?: string }) => b.text ?? "").join(" "));
			}
		}
		return texts;
	} catch {
		return [];
	}
}
