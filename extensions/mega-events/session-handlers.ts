/**
 * mega-events/session-handlers.ts — pi session lifecycle event handlers.
 *
 * Registers model/provider capture, session start/tree/shutdown, and the
 * before_agent_start auto-inline injection point.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeSessionId } from "../../src/store.js";
import { autoMaintain } from "../../src/store/sqlite.js";
import {
	type MegaRuntime,
	recentUserQuery,
	WIDGET_KEY,
} from "../mega-runtime.js";
import {
	doRecall,
	doRecallAsync,
} from "../mega-pipeline.js";
import { recallMemoriesAndInline } from "../../src/recall.js";
import type { MegaConfig } from "../mega-config.js";

/** Register session lifecycle event handlers. */
export function registerSessionHandlers(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// Capture model/provider whenever it changes (drives real cost estimation).
	pi.on("model_select", async (_event, ctx) => {
		runtime.captureModel(ctx);
		runtime.snapshot(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		runtime.resetRuntime(ctx.sessionManager.getSessionId());
		runtime.captureModel(ctx); // best-effort: ctx.model may be set by session start
		runtime.setStatus(
			ctx,
			config.auto ? "mega-compact: ready" : "mega-compact: manual only",
		);
		// S21: clear any stale memory block from a prior session.
		runtime.pendingMemoryRecallBlock = undefined;
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
				// S17: use the async variant on resume so cross-repo HNSW recall can
				// augment when this repo's store is thin. session_start is an async-safe
				// point (unlike the mid-turn context handler, which stays sync).
				const r = await doRecallAsync(runtime, config, ctx, query, "resume", {
					crossRepo: config.crossRepoEnabled,
				});
				if (!r.empty) {
					runtime.pendingRecallBlock = r.block;
					const crossLabel = r.toInject.some((h) => h.repoId)
						? " (cross-repo)"
						: "";
					runtime.setStatus(
						ctx,
						`mega-compact: recalled ${r.toInject.length} chkpt${crossLabel}`,
					);
					runtime.logger.info("auto-inline", {
						reason: event.reason,
						query,
						injected: r.toInject.map((h) => h.checkpoint.checkpointId),
						crossRepo: r.toInject.some((h) => h.repoId),
					});
				}
			}
			// S21: parallel memory recall. Same async context so we can await without
			// breaking the handler contract. Best-effort — never throws.
			try {
				const mr = await recallMemoriesAndInline({
					query,
					stateDir: runtime.getStateDir(),
					limit: 5,
					crossRepo: config.crossRepoEnabled,
					crossRepoCosine: config.crossRepoCosine,
				});
				if (!mr.empty) runtime.pendingMemoryRecallBlock = mr.block;
			} catch (err) {
				runtime.logger.warn("memory-recall skipped", { err: String(err) });
			}
		}
		// S27 Task 10: best-effort auto-maintenance on session start (prune rows
		// older than 30d, checkpoint WAL if >10MB, VACUUM if DB >100MB + >20%
		// freelist). Never blocks session start — swallows errors and logs a
		// one-line summary for diagnostics.
		try {
			const m = autoMaintain(runtime.currentStateDir);
			if (m && !m.endsWith("nothing to do")) runtime.logger.info("db-auto-maintain", { result: m });
		} catch (e) {
			runtime.logger.warn("db-auto-maintain-fail", { error: String(e) });
		}
		runtime.dashboard.event("session_start", {
			reason: event.reason,
			sessionId: runtime.rt.sessionId,
		});
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
					runtime.logger.info("auto-inline", {
						reason: "session_tree",
						query,
						injected: r.toInject.map((h) => h.checkpoint.checkpointId),
					});
				}
				// S21: parallel memory recall. Trigram embedder is sub-ms; await is fine.
				try {
					const mr = await recallMemoriesAndInline({
						query,
						stateDir: runtime.getStateDir(),
						limit: 5,
						crossRepo: config.crossRepoEnabled,
						crossRepoCosine: config.crossRepoCosine,
					});
					if (!mr.empty) runtime.pendingMemoryRecallBlock = mr.block;
				} catch (err) {
					runtime.logger.warn("memory-recall skipped", { err: String(err) });
				}
			}
		}
		runtime.dashboard.event("session_tree", {
			sessionId: runtime.rt.sessionId,
		});
		runtime.snapshot(ctx);
	});

	// ---- Auto-inline injection point: prepend staged recall to systemPrompt ----
	pi.on("before_agent_start", async (event, ctx) => {
		runtime.captureModel(ctx); // most reliable point ctx.model is populated
		const cpBlock = runtime.pendingRecallBlock;
		const memBlock = runtime.pendingMemoryRecallBlock;
		if (!cpBlock && !memBlock) return;
		runtime.pendingRecallBlock = undefined;
		runtime.pendingMemoryRecallBlock = undefined;
		const composed = [cpBlock, memBlock].filter(Boolean).join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${composed}` };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtime.setStatus(ctx, undefined);
		runtime.activeAgents = 0;
		runtime.currentTurn = 0;
		ctx.ui.setWidget(WIDGET_KEY, [], { placement: "aboveEditor" });
	});
}
