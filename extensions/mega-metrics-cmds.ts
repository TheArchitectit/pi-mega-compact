/**
 * mega-metrics-cmds.ts — S50C per-turn memory-quality /commands.
 *
 * Registers /mega-metrics and /mega-fork, backed by the pi-agnostic
 * src/metrics/turns.ts rollups and src/fork.ts primitive over the isolated
 * S49 turns.db. Read-only (PREVENT-PI-001/002 — these never mutate memory,
 * drop ranges, or compaction); local SQLite only (PREVENT-PI-004);
 * parameterized queries (PREVENT-002). Both require turnsDbEnabled (the
 * isolated store); they no-op with guidance on the legacy main-db path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "./mega-runtime.js";
import type { MegaConfig } from "./mega-config.js";
import { turnStoreFor, mainDbFor } from "./mega-turn-store.js";
import { turnMetrics, conversationMetrics } from "../src/metrics/index.js";
import { forkFromConversation, ForkError } from "../src/fork.js";
import { ensureConversationIdFor } from "./mega-turn-store.js";

function pct(r: number): string {
	return `${(r * 100).toFixed(1)}%`;
}

/** Register the /mega-metrics + /mega-fork commands. */
export function registerMetricsCommands(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	pi.registerCommand("mega-metrics", {
		description:
			"Show per-turn + per-conversation memory-quality metrics (recall reuse, dedup ratio, compression ratio). Usage: /mega-metrics [conversationId]",
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				runtime.bindRepo(ctx.cwd);
				const stateDir = runtime.currentStateDir;
				const store = turnStoreFor(config, stateDir);
				if (!store) {
					ctx.ui.notify(
						"[mega-compact] /mega-metrics requires the isolated turns.db (set turnsDbEnabled on).",
					);
					return;
				}
				const conv =
					args.trim() ||
					ensureConversationIdFor(config, runtime.rt.sessionId, stateDir);
				const mainDb = mainDbFor(stateDir);
				const perTurn = turnMetrics(store, mainDb, conv);
				if (perTurn.length === 0) {
					ctx.ui.notify(`[mega-compact] no turns recorded for conversation ${conv}.`);
					return;
				}
				const agg = conversationMetrics(store, mainDb, conv);
				ctx.ui.notify(
					`[mega-compact] conversation ${conv} — ${agg.turnCount} turns, ${agg.epochCount} epoch(s), total recall ${agg.totalRecall}, total raw msgs ${agg.totalRawMessages}`,
				);
				ctx.ui.notify(
					`  avg dedup unique ratio ${pct(agg.avgDedupUniqueRatio)} · avg compression ratio ${pct(agg.avgCompressionRatio)}`,
				);
				for (const t of perTurn) {
					ctx.ui.notify(
						`  turn ${t.turnIndex} (epoch ${t.epochId ?? "—"}): recall ${t.recallCount}, raw ${t.rawMessageCount}, dedup ${pct(t.dedupUniqueRatio)}, compress ${pct(t.compressionRatio)}`,
					);
				}
			} catch (e) {
				ctx.ui.notify(`[mega-compact] /mega-metrics failed: ${String(e)}`);
			}
		},
	});

	pi.registerCommand("mega-fork", {
		description:
			"Fork the current conversation at turn N into a new child conversation, rehydrating that turn's injected checkpoints (recall-to-point, not window replay). Usage: /mega-fork <turnIndex> [conversationId]",
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				runtime.bindRepo(ctx.cwd);
				const stateDir = runtime.currentStateDir;
				const store = turnStoreFor(config, stateDir);
				if (!store) {
					ctx.ui.notify(
						"[mega-compact] /mega-fork requires the isolated turns.db (set turnsDbEnabled on).",
					);
					return;
				}
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const turnIndex = Number.parseInt(parts[0] ?? "", 10);
				if (!Number.isFinite(turnIndex)) {
					ctx.ui.notify("[mega-compact] /mega-fork needs a turn index, e.g. /mega-fork 3");
					return;
				}
				const conv =
					parts[1] ||
					ensureConversationIdFor(config, runtime.rt.sessionId, stateDir);
				const out = forkFromConversation(store, conv, turnIndex);
				runtime.logger.info("fork", {
					parent: conv,
					child: out.childConversationId,
					turnIndex,
					checkpoints: out.checkpointIds,
				});
				ctx.ui.notify(
					`[mega-compact] forked ${conv} @ turn ${turnIndex} → ${out.childConversationId}\n` +
						`  replay set (${out.checkpointIds.length} checkpoint(s)): ${out.checkpointIds.join(", ")}`,
				);
			} catch (e) {
				if (e instanceof ForkError) {
					ctx.ui.notify(`[mega-compact] /mega-fork: ${e.message}`);
				} else {
					ctx.ui.notify(`[mega-compact] /mega-fork failed: ${String(e)}`);
				}
			}
		},
	});
}
