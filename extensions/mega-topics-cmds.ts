/**
 * mega-topics-cmds.ts — S51C /mega-topics + /mega-topic commands.
 *
 * Lists auto-categorized wiki topics and renders wiki pages via ctx.ui.notify.
 * Read-only (PREVENT-PI-001/002); local SQLite only (PREVENT-PI-004);
 * parameterized queries (PREVENT-002). Requires turnsDbEnabled; no-ops with
 * guidance when OFF or when AUTO_WIKI_ENABLED is false.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "./mega-runtime.js";
import type { MegaConfig } from "./mega-config.js";
import { createTopicStore } from "../src/topics/store.js";
import { buildTopicModel } from "../src/topics/cluster.js";
import { openStore } from "../src/store/sqlite/utils.js";

/** Register the /mega-topics + /mega-topic commands. */
export function registerTopicsCommands(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	pi.registerCommand("mega-topics", {
		description:
			"List auto-categorized wiki topics (k-means + TF-IDF over real embeddings). Usage: /mega-topics",
		handler: async (_args: string, ctx: ExtensionContext) => {
			try {
				if (!config.turnsDbEnabled || !config.autoWikiEnabled) {
					ctx.ui.notify(
						"[mega-compact] /mega-topics requires turnsDbEnabled + autoWikiEnabled.",
					);
					return;
				}
				runtime.bindRepo(ctx.cwd);
				const stateDir = runtime.currentStateDir;
				const topicStore = createTopicStore(stateDir);
				const topics = topicStore.getTopics();
				const stats = topicStore.getTopicStats();

				if (topics.length === 0) {
					ctx.ui.notify(
						"[mega-compact] No topics yet. Topics are auto-generated after every 10th compaction from real memory embeddings (k-means + TF-IDF).",
					);
					return;
				}

				ctx.ui.notify(
					`[mega-compact] ${stats.totalTopics} topic(s) · ${stats.totalAssigned} assigned memories` +
						(stats.lastRebuildAt
							? ` · last rebuild ${new Date(stats.lastRebuildAt).toLocaleString()}`
							: ""),
				);
				for (const t of topics) {
					const terms = t.termScores
						.slice(0, 5)
						.map((s) => s.term)
						.join(", ");
					ctx.ui.notify(
						`  ${t.id}: ${t.label} (${t.memoryCount} memories) — terms: ${terms}`,
					);
				}
			} catch (e) {
				ctx.ui.notify(`[mega-compact] /mega-topics failed: ${String(e)}`);
			}
		},
	});

	pi.registerCommand("mega-topic", {
		description: "Show a wiki page for one topic. Usage: /mega-topic <topicId>",
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				if (!config.turnsDbEnabled || !config.autoWikiEnabled) {
					ctx.ui.notify(
						"[mega-compact] /mega-topic requires turnsDbEnabled + autoWikiEnabled.",
					);
					return;
				}
				const topicId = args.trim();
				if (!topicId) {
					ctx.ui.notify(
						"[mega-compact] /mega-topic needs a topic id, e.g. /mega-topic topic_0",
					);
					return;
				}
				runtime.bindRepo(ctx.cwd);
				const stateDir = runtime.currentStateDir;
				const topicStore = createTopicStore(stateDir);
				const topics = topicStore.getTopics();
				const topic = topics.find((t) => t.id === topicId);
				if (!topic) {
					ctx.ui.notify(
						`[mega-compact] topic ${topicId} not found. Use /mega-topics to list.`,
					);
					return;
				}

				// Show topic details.
				const assignments = topicStore.getMemoriesForTopic(topicId);
				ctx.ui.notify(
					`[mega-compact] ${topic.id}: ${topic.label} (${topic.memoryCount} memories)`,
				);
				const terms = topic.termScores
					.slice(0, 8)
					.map((s) => `${s.term} (${s.score.toFixed(2)})`)
					.join(", ");
				ctx.ui.notify(`  terms: ${terms}`);
				ctx.ui.notify(`  assignments: ${assignments.length} memories`);
				for (const a of assignments.slice(0, 10)) {
					ctx.ui.notify(
						`    ${a.memoryId} — confidence ${(a.confidence * 100).toFixed(1)}%`,
					);
				}
				if (assignments.length > 10) {
					ctx.ui.notify(`    ... and ${assignments.length - 10} more`);
				}
			} catch (e) {
				ctx.ui.notify(`[mega-compact] /mega-topic failed: ${String(e)}`);
			}
		},
	});

	pi.registerCommand("mega-topics-rebuild", {
		description:
			"Force-rebuild the topic model now (k-means + TF-IDF over real embeddings). Usage: /mega-topics-rebuild",
		handler: async (_args: string, ctx: ExtensionContext) => {
			try {
				if (!config.turnsDbEnabled || !config.autoWikiEnabled) {
					ctx.ui.notify(
						"[mega-compact] /mega-topics-rebuild requires turnsDbEnabled + autoWikiEnabled.",
					);
					return;
				}
				runtime.bindRepo(ctx.cwd);
				const stateDir = runtime.currentStateDir;
				const db = openStore(stateDir);
				const model = buildTopicModel(db);
				createTopicStore(stateDir).replaceTopicModel(model);
				ctx.ui.notify(
					`[mega-compact] wiki rebuilt: ${model.k} topics from ${model.totalChunks} chunks (${model.criterion}, silhouette=${model.silhouetteScore?.toFixed(3) ?? "n/a"})`,
				);
			} catch (e) {
				ctx.ui.notify(
					`[mega-compact] /mega-topics-rebuild failed: ${String(e)}`,
				);
			}
		},
	});
}
