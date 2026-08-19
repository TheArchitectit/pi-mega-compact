/**
 * run.ts — full compaction pipeline (Trident) + the 3WF-2 advisory vote wiring.
 *
 * `runCompact` runs the full Trident pipeline (fast-gate aside) and persists a
 * checkpoint. Moved here from extensions/mega-pipeline/compact.ts as part of
 * the delegate-shell split (the shell re-exports the public API unchanged).
 *
 * Behavior change in this file vs v0.20.83: AFTER compactSession returns a
 * non-skipped result AND the 3WF umbrella flag (config.threeWayFailback) is ON,
 * the 3-source vote (voteCandidate) runs OBSERVATIONALLY — it logs the outcome
 * and never mutates the result. supersede stays exactly as src/engine.ts:143
 * (the unchanged precondition): we do NOT change compactSession, do NOT
 * overwrite result.summary, and do NOT re-persist a checkpoint. A rejected
 * vote (returned null) keeps the supersede-only result — which is what happens
 * when the vote does not mutate anything. Flag OFF ⇒ the vote code does not run
 * at all (byte-identical to v0.20.83).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactSession } from "../../../src/engine.js";
import type { EngineMessage } from "../../../src/types.js";
import { normalizeSessionId } from "../../../src/store.js";
import { repoKey } from "../../../src/store/repoKey.js";
import { touchSession, logDaily, incCompactCount, incCacheHitTokens } from "../../../src/store/sqlite.js";
import { consolidateMemories } from "../../../src/memory.js";
import {
	type MegaRuntime,
	C,
	MARKER_TYPE,
} from "../../mega-runtime.js";
import { resolveRepoRoot, preserveRecentForPressure, type MegaConfig } from "../../mega-config.js";
import { runRaptor } from "../../../src/dedup/raptor/index.js";
import { isRaptorTreeFresh } from "../../../src/dedup/raptor/buildHistory.js";
import { loadDedupConfig } from "../../../src/config/dedup.js";
import { upsertEmbedding as indexUpsertEmbedding } from "../../../src/store/vectorIndex.js";
import { runMemoryReview } from "../memory-review.js";
import { vectorList } from "../../../src/vectorStore.js";
import { wireCompactVote } from "./vote.js";

export type RunCompactResult =
	| { skipped: true }
	| { skipped: false; result: ReturnType<typeof compactSession>; keepFrom: number; saved: number };

/** Run the full compaction pipeline and persist a checkpoint. Returns the result. */
export function runCompact(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
	ctx: ExtensionContext,
	messages: AgentMessage[],
	opts: { keepFrom?: number; summary?: string; compressionPressure?: number } = {},
): RunCompactResult {
	runtime.bindRepo(ctx.cwd);
	const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
	runtime.resetRuntime(sid);
	runtime.rt.sessionId = sid;

	const view = runtime.engineView(messages);
	// keepFrom deepens with context pressure (Fix E): under high pressure we
	// compact more of the session, down to the preserveRecentMin floor.
	const preserve = preserveRecentForPressure(
		opts.compressionPressure ?? 0,
		config.preserveRecent,
		config.preserveRecentMin,
	);
	const keepFrom = opts.keepFrom ?? Math.max(0, view.length - preserve);
	// For very small sessions (fewer messages than preserveRecent), allow
	// compacting everything except the last message — the user explicitly
	// requested compaction, so don't refuse it just because the session is short.
	if (keepFrom <= 0) {
		if (view.length <= 1) return { skipped: true };
		// Use the fallback: compact everything except the last message
		const fallbackKeepFrom = view.length - 1;
		return doCompact(view, fallbackKeepFrom, opts, sid, config, pi, ctx, runtime);
	}

	return doCompact(view, keepFrom, opts, sid, config, pi, ctx, runtime);
}

function doCompact(
	view: EngineMessage[],
	keepFrom: number,
	opts: { keepFrom?: number; summary?: string; compressionPressure?: number },
	sid: string,
	config: MegaConfig,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: MegaRuntime,
): RunCompactResult {
	runtime.pulsing = true; // animate the status line while the (sync) pipeline runs
	runtime.setEffect?.("pulse", "accent", 1500); // v0.8.3: ambient border pulse during compaction
	// S21.2: reset the per-compaction memory-op counter so the post-compact
	// consolidate pass only fires when memory rows actually changed during the
	// compaction window (turn_end → auto-review may have written some).
	runtime.memoriesTouchedThisCompaction = 0;
	const result = compactSession(
		{
			sessionId: sid,
			messages: view,
			keepFrom,
			summary: opts.summary,
			timestamp: Date.now(),
			onTier: runtime.makeTierCallback(ctx),
			compressionPressure: opts.compressionPressure,
		},
		runtime.store,
	);
	runtime.pulsing = false;

	if (result.skipped) return { skipped: true };
	// C1 (v0.21.10): lastCheckpointId tracks "the checkpoint backing this epoch",
	// so it is stamped on BOTH paths — a matched-dedup checkpoint backs this epoch
	// just as much as a freshly created one. Previously the dedup path left it
	// undefined, so a runtime session whose every compaction deduped (common after
	// a process restart, when checkpoints persist but `rt` is rebuilt) never set it
	// → liveTrim's trimCache fell back to result.checkpointId (the matched id) →
	// `trimCache.checkpointId === rt.lastCheckpointId` was `"chkpt_001" !== undefined`
	// → the D.2/D.3 replay NEVER matched and the full pipeline re-ran on every
	// context event (liveTrimReplays: 0, "comp lag warn"). A later fire matching a
	// DIFFERENT checkpoint now changes the key once (one cache regeneration), then
	// replays stabilise. `persistedThisSession` keeps its narrower meaning ("we
	// wrote NEW state this session") and stays gated on !deduped.
	if (!result.deduped) runtime.rt.persistedThisSession = true;
	runtime.rt.lastCheckpointId = result.checkpointId;
	runtime.rt.lastCompactedFrom = result.compactedFrom;
	runtime.rt.lastCompactedTokens = result.tokenEstimate;
	runtime.rt.dedupAttempts++;
	// Honest "tokens saved" for this session-instance only:
	//   new checkpoint      → original − stored
	//   deduped onto existing → whole original region (nothing new stored)
	// Resets to 0 on session_start (rt is rebuilt) — so a fresh session shows 0
	// while the repo's cumulative saved (SQLite meta) keeps the running total.
	const saved = result.deduped
		? result.originalTokenEstimate
		: Math.max(0, result.originalTokenEstimate - result.tokenEstimate);
	runtime.rt.tokensSaved += saved;
	runtime.rt.compactCount += 1;
	incCompactCount(runtime.currentStateDir);
	if (result.deduped) { runtime.rt.cacheHitTokens += saved; incCacheHitTokens(saved, runtime.currentStateDir); }
	runtime.rt.lastCompactAt = Date.now();
	if (result.deduped) runtime.rt.dedupSkips++;
	// Grow the rolling "saved" goal so the progress bar always has a fresh
	// denominator (we don't want it pinned at 100% once we pass an old target).
	if (runtime.rt.tokensSaved > runtime.savedGoal) runtime.savedGoal = Math.ceil((runtime.rt.tokensSaved * 1.25) / 10_000) * 10_000;

	// Live toolbar activity: what file/region just got compacted or deduped.
	// Rendered via the rotating ticker line (see snapshot); the ring buffer is
	// cycled one-per-repaint so the single line scrolls through recent files.
	const files = result.filesModified ?? [];
	const fileLabel = files.length
		? files.map((f) => f.split("/").pop() ?? f).slice(0, 2).join(", ")
		: result.regionHash.slice(0, 8);
	runtime.lastActivityAt = Date.now();
	// Explain-why line: surfaced while fresh. Pulls the dedup reason (which for
	// L2 includes the cosine sim) so the user sees WHY a region was kept/dropped.
	runtime.lastWhy = result.deduped
		? `why: deduped@${result.dedupReason ?? "tier"}`
		: `why: compacted → ${result.checkpointId}`;
	// Recall/activity ticker: record this event in the ring buffer.
	const savedK = (saved / 1000).toFixed(1);
	runtime.pushTicker(
		result.deduped
			? `${C.green}♻${C.reset} deduped ${fileLabel} · ${savedK}k saved`
			: `${C.cyan}🗜${C.reset} ${result.checkpointId} · +${savedK}k · ${fileLabel}`,
	);
	// The per-tier trace has settled into the final outcome — fold it back into
	// the activity line and stop showing the live trace.
	runtime.tierTrace = undefined;

	// Record session activity + a daily-log entry in the per-repo SQLite store
	// (foundation for resume-sessions / daily-log features). Best-effort — never
	// block a compaction on bookkeeping.
	try {
		const root = resolveRepoRoot(ctx.cwd);
		touchSession(sid, root, runtime.currentStateDir);
		logDaily(sid, "compact", result.checkpointId, saved, runtime.currentStateDir);
	} catch {
		// Sprint H (Option A): session-activity / daily-log write is an internal
		// store-write failure — feed the separate `storeErrorRate` axis.
		runtime.recordInternalError("store_write");
		/* non-fatal: stats bookkeeping only */
	}

	// S21.2: best-effort consolidation of near-duplicate memories for this repo.
	// Runs after the per-repo stats touch so `consolidateMemories` can use the
	// same stateDir. Non-fatal — a failed consolidate never blocks a compaction.
	// Only runs when new memory ops landed in this pass (otherwise the prior
	// compaction's consolidate already had its shot — re-running would just
	// touch every row again with no merges).
	if (!result.deduped && runtime.memoriesTouchedThisCompaction > 0) {
		try {
			const root = resolveRepoRoot(ctx.cwd);
			void consolidateMemories(runtime.currentStateDir, root).then(
				(n) => {
					if (n > 0) runtime.pushTicker(`${C.green}∫${C.reset} consolidated ${n} memory dup${n === 1 ? "" : "s"}`);
				},
				() => {
					// Sprint H (Option A): memory-consolidation write failure.
					runtime.recordInternalError("store_write");
					/* swallow: consolidate failures must never surface to the user */
				},
			);
		} catch {
			// Sprint H (Option A): memory-consolidation write failure (sync throw).
			runtime.recordInternalError("store_write");
			/* non-fatal */
		}
	}

	// S24 review-on-compact: when pressure is high, the just-compacted region is
	// exactly the context worth remembering, so review it immediately rather than
	// waiting for the next turn-cadence tick. Uses the shared runMemoryReview
	// helper (fire-and-forget; doCompact is sync). Best-effort + non-fatal. Only
	// fires above the `high` band so low-pressure compactions don't pay the cost.
	if (!result.deduped && config.memoryAutoReview && runtime.pressureBand !== "low" && runtime.pressureBand !== "medium") {
		void runMemoryReview(runtime, view, "pressure");
	}

	// Sentinel marker: a non-LLM bookkeeping entry so subsequent triggers can
	// skip re-vectorizing an already-compacted region (zero token cost).
	// v0.8.6: gate on !result.deduped so the marker ONLY lands when a genuinely
	// new checkpoint was created. Without this, every dedup re-fire appended a
	// fresh sentinel to the real transcript, bloating it and perturbing the
	// provider KV-cache prefix (the alternating cache-miss regression). Matches
	// the RAPTOR + vector-index blocks above, which are already !deduped-gated.
	if (!result.deduped) {
		pi.appendEntry(MARKER_TYPE, {
			checkpointId: result.checkpointId,
			regionHash: result.regionHash,
			tokenEstimate: result.tokenEstimate,
			deduped: result.deduped,
		});
	}

	// Fix D: refresh the RAPTOR tree for this session so live recall (search) can
	// serve high-level summaries. Best-effort + non-fatal: never block compaction.
	// Budget-guarded (RAPTOR_BUDGET_MS) so it can't hang a large session.
	if (config.raptorEnabled && !result.deduped) {
		try {
			const dd = loadDedupConfig();
			const all = vectorList(runtime.store, sid);
			const leaves = all.map((cp) => ({
				id: cp.checkpointId,
				messages: [],
				sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
				embedding: cp.embedding,
			}));
			if (leaves.length >= 2) {
				// S42D: skip the rebuild when the last build is fresh (within
				// RAPTOR_FRESHNESS_HOURS) and the checkpoint count hasn't drifted by
				// more than 20%. avoids re-clustering on every compaction when the
				// tree is still representative. 0 disables (always rebuild).
				if (
					dd.RAPTOR_FRESHNESS_HOURS > 0 &&
					isRaptorTreeFresh(sid, runtime.currentStateDir, dd.RAPTOR_FRESHNESS_HOURS, all.length)
				) {
					runtime.logger?.info("raptor_skip_fresh", { sessionId: sid });
				} else {
					// S25: stamp the tree with the newest checkpoint epoch so the
					// freshness guard in raptorSearchHits can reject stale trees after a
					// later compaction adds newer checkpoints.
					const builtAt = all.length > 0 ? Math.max(...all.map((c) => c.timestamp)) : Date.now();
					runRaptor(
						leaves,
						{
							stateDir: runtime.currentStateDir,
							sessionId: sid,
							budgetMs: dd.RAPTOR_BUDGET_MS,
							clustersPerLevel: dd.RAPTOR_CLUSTERS_PER_LEVEL,
							consistencyThreshold: dd.RAPTOR_CONSISTENCY,
							logger: runtime.logger,
							builtAt: Number.isFinite(builtAt) ? builtAt : Date.now(),
						},
					);
				}
			}
		} catch {
			// Sprint H (Option A): RAPTOR tree-refresh write failure.
			runtime.recordInternalError("vector_index");
			/* non-fatal: tree refresh never blocks a compaction */
		}
	}

	// Slice 2: best-effort mirror of the new checkpoint into the async global
	// PGlite/HNSW vector index. Fires once per compaction (not per-add), so the
	// shared global dir is never hammered by concurrent test workers.
	// Non-fatal: a WASM init failure degrades to the sync scan silently.
	if (!result.deduped) {
		try {
			const all = vectorList(runtime.store, sid);
			const latest = all.find((cp) => cp.checkpointId === result.checkpointId);
			if (latest?.embedding) {
				void indexUpsertEmbedding(
					repoKey(runtime.currentStateDir),
					sid,
					latest.checkpointId,
					latest.embedding,
				).catch(() => {
					// Sprint H (Option A): async global vector-index upsert failure.
					runtime.recordInternalError("vector_index");
					/* non-fatal: index refresh never blocks a compaction */
				});
			}
		} catch {
			/* non-fatal: index refresh never blocks a compaction */
		}
	}

	runtime.setStatus(
		ctx,
		runtime.rt.persistedThisSession
			? `mega-compact: ${result.checkpointId} · ${saved} tok saved`
			: `mega-compact: ready`,
	);
	runtime.logger.info("compact", {
		sessionId: sid,
		checkpointId: result.checkpointId ?? "(deduped)",
		deduped: result.deduped,
		tokenEstimate: saved,
		compactedFrom: result.compactedFrom,
	});
	runtime.dashboard.event("compact", {
		sessionId: sid,
		checkpointId: result.checkpointId ?? "(deduped)",
		deduped: result.deduped,
		tokenEstimate: saved,
		compactedFrom: result.compactedFrom,
	});
	runtime.snapshot(ctx);

	// 3WF-2: OBSERVATIONAL vote only. supersede (src/engine.ts:143) is the
	// unchanged precondition; this never mutates result or re-persists anything.
	// The winner label + reduction are logged for telemetry. Non-fatal: any
	// failure here must never break the compaction above.
	try {
		wireCompactVote(runtime, config, sid, result, view, keepFrom);
	} catch {
		/* non-fatal: telemetry-only vote must never break a compaction */
	}

	return { skipped: false, result, keepFrom, saved };
}
