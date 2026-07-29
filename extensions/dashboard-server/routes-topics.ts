/**
 * routes-topics.ts — S51 auto-categorizing wiki topics route handler.
 *
 * GET /api/topics — Returns topic list with memory counts + TF-IDF labels.
 * Read-only (PREVENT-PI-001/002); parameterized queries (PREVENT-002);
 * pure local node:sqlite (PREVENT-PI-004).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import { createTopicStore } from "../../src/topics/store.js";
import type { TopicsResponse, TopicRow } from "./api-contracts/game-types.js";
import type { TopicMemoriesResponse } from "./api-contracts/turns.js";

export function handleTopics(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	// ── GET /api/topics/:topicId/memories — wiki topic drill-down (S52) ──
	const drillMatch =
		req.method === "GET"
			? url.match(/^\/api\/topics\/([^/?]+)\/memories$/)
			: null;
	if (drillMatch) {
		try {
			const topicId = decodeURIComponent(drillMatch[1]);
			const store = createTopicStore(ctx.stateDir);
			const topics = store.getTopics();
			const topic = topics.find((t) => t.id === topicId);
			const assignments = store.getMemoriesForTopic(topicId, 200);
			const body: TopicMemoriesResponse = {
				topicId,
				label: topic?.label ?? topicId,
				assignments: assignments.map((a) => ({
					memoryId: a.memoryId,
					confidence: a.confidence ?? null,
					assignedAt: a.assignedAt ?? null,
				})),
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(e) }));
		}
		return true;
	}

	if (url !== "/api/topics") return false;

	try {
		const tdb = openTurnStore(ctx.stateDir);
		const topics: TopicRow[] = (
			tdb
				.prepare(
					`SELECT id, label, term_scores, memory_count, last_updated
           FROM topics ORDER BY memory_count DESC, id ASC`,
				)
				.all() as Array<{
				id: string;
				label: string;
				term_scores: string | null;
				memory_count: number;
				last_updated: number | null;
			}>
		).map((r) => ({
			id: r.id,
			label: r.label,
			memoryCount: r.memory_count,
			lastUpdated: r.last_updated ?? 0,
			termScore: safeParse(r.term_scores),
		}));

		const totalAssigned = (
			tdb.prepare("SELECT COUNT(*) AS c FROM memory_topics").get() as {
				c: number;
			}
		).c;

		const lastRebuildAt = (
			tdb
				.prepare("SELECT MAX(cluster_model_built_at) AS m FROM topics")
				.get() as { m: number | null }
		).m;

		const body: TopicsResponse = {
			updatedAt: new Date().toISOString(),
			totalTopics: topics.length,
			totalAssigned,
			lastRebuildAt,
			topics,
		};

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: String(e) }));
	}

	return true;
}

function safeParse(
	json: string | null,
): Array<{ term: string; score: number }> {
	if (!json) return [];
	try {
		const v = JSON.parse(json) as unknown;
		return Array.isArray(v)
			? (v as Array<{ term: string; score: number }>)
			: [];
	} catch {
		return [];
	}
}
