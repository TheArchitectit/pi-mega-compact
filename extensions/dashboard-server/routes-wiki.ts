/**
 * dashboard-server/routes-wiki.ts — W2 wiki revival routes (curation + provenance).
 *
 * GET  /api/wiki/index                     — topics with resolved labels
 * GET  /api/wiki/evolution                 — D3 nodes/edges/time buckets
 * GET  /api/wiki/topic/:topicId            — single topic page + provenance
 * GET  /api/wiki/topic/:topicId/timeline   — per-topic time buckets
 * PUT  /api/wiki/topic/:topicId/label      — rename (emits wiki_topic_renamed)
 * POST /api/wiki/merge                     — merge (emits wiki_topics_merged)
 * POST /api/wiki/topic/:topicId/split      — split (emits wiki_topic_split)
 *
 * Flag-gated by MEGACOMPACT_WIKI_ENHANCED (flag-OFF → 404 for all /api/wiki/*).
 * Read/build helpers live in routes-wiki-helpers.ts (pointer-file split).
 * Loopback-only (PREVENT-PI-004); parameterized (PREVENT-002); no `any`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { TurnsConfig } from "../../src/config/turns.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import { createTopicStore } from "../../src/topics/store.js";
import { extractiveSummary } from "../../src/wiki.js";
import { createWikiCuration } from "../../src/wiki/curation.js";
import {
	emitWikiEvent,
	ensureWikiBuilt,
	toIndexEntry,
	toProvenance,
	bucketize,
	memberContent,
} from "./routes-wiki-helpers.js";
import type {
	WikiIndexResponse,
	WikiPageResponse,
	TopicEvolutionResponse,
	TopicTimelineResponse,
	CurationResult,
} from "./api-contracts/wiki.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Decode a percent-encoded path segment; null on malformed encoding (%zz). */
function decodeSegment(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

/** Read a capped JSON body; returns { ok, value } or { error }. */
function readJsonBody(
	req: IncomingMessage,
	cb: (
		result:
			| { ok: true; value: Record<string, unknown> }
			| { ok: false; error: string },
	) => void,
): void {
	let body = "";
	let tooBig = false;
	req.on("data", (chunk: Buffer) => {
		if (body.length > 65536) {
			tooBig = true;
			return;
		}
		body += chunk.toString();
	});
	req.on("end", () => {
		if (tooBig) return cb({ ok: false, error: "body_too_large" });
		try {
			const v = body ? JSON.parse(body) : {};
			if (typeof v !== "object" || v === null || Array.isArray(v)) {
				return cb({ ok: false, error: "invalid_object" });
			}
			cb({ ok: true, value: v as Record<string, unknown> });
		} catch {
			cb({ ok: false, error: "invalid_json" });
		}
	});
}

export function handleWiki(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	if (!url.startsWith("/api/wiki")) return false;

	// Flag gate: feature-OFF → 404 for every wiki endpoint.
	if (!TurnsConfig.WIKI_ENHANCED_ENABLED) {
		sendJson(res, 404, { error: "wiki_enhanced_disabled" });
		return true;
	}

	// ── GET /api/wiki/index ──────────────────────────────────────────
	if (req.method === "GET" && url === "/api/wiki/index") {
		try {
			const tdb = openTurnStore(ctx.stateDir);
			ensureWikiBuilt(ctx, tdb);
			const store = createTopicStore(ctx.stateDir);
			const curation = createWikiCuration(ctx.stateDir);
			const entries = store.getTopics().map((t) => toIndexEntry(t, curation));
			const totalMemories = entries.reduce((s, e) => s + e.memoryCount, 0);
			const lastRebuildAt =
				entries.length > 0 ? Math.max(...entries.map((e) => e.lastUpdated)) : null;
			const body: WikiIndexResponse = {
				topics: entries,
				totalTopics: entries.length,
				totalMemories,
				lastRebuildAt,
			};
			sendJson(res, 200, body);
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
		}
		return true;
	}

	// ── GET /api/wiki/evolution ──────────────────────────────────────
	if (req.method === "GET" && url === "/api/wiki/evolution") {
		try {
			const tdb = openTurnStore(ctx.stateDir);
			const curation = createWikiCuration(ctx.stateDir);
			const nodes = createTopicStore(ctx.stateDir)
				.getTopics()
				.map((t) => ({
					id: t.id,
					label: curation.resolveLabel(t.id, t.label).label,
					memoryCount: t.memoryCount,
				}));
			const overrides = tdb
				.prepare(
					`SELECT kind, topic_id, merged_into, split_from, overridden_at
					 FROM topic_overrides WHERE kind IN ('merge','split')`,
				)
				.all() as Array<{
				kind: string;
				topic_id: string;
				merged_into: string | null;
				split_from: string | null;
				overridden_at: number;
			}>;
			const edges = overrides.flatMap(
				(o): TopicEvolutionResponse["edges"][number][] => {
					if (o.kind === "merge" && o.merged_into) {
						return [
							{
								source: o.topic_id,
								target: o.merged_into,
								kind: "merge",
								at: o.overridden_at,
							},
						];
					}
					if (o.kind === "split" && o.split_from) {
						return [
							{
								source: o.split_from,
								target: o.topic_id,
								kind: "split",
								at: o.overridden_at,
							},
						];
					}
					return [];
				},
			);
			const evoRows = tdb
				.prepare("SELECT assigned_at FROM topic_evolution")
				.all() as Array<{ assigned_at: number }>;
			const body: TopicEvolutionResponse = {
				nodes,
				edges,
				buckets: bucketize(evoRows.map((r) => r.assigned_at)),
			};
			sendJson(res, 200, body);
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
		}
		return true;
	}

	// ── GET /api/wiki/topic/:topicId/timeline ────────────────────────
	const timelineMatch =
		req.method === "GET"
			? url.match(/^\/api\/wiki\/topic\/([^/?]+)\/timeline$/)
			: null;
	if (timelineMatch) {
		const topicId = decodeSegment(timelineMatch[1]);
		if (topicId === null) {
			sendJson(res, 400, { error: "malformed_topic_id" });
			return true;
		}
		try {
			const tdb = openTurnStore(ctx.stateDir);
			const rows = tdb
				.prepare("SELECT assigned_at FROM memory_topics WHERE topic_id = ?")
				.all(topicId) as Array<{ assigned_at: number }>;
			const body: TopicTimelineResponse = {
				topicId,
				buckets: bucketize(rows.map((r) => r.assigned_at)),
				total: rows.length,
			};
			sendJson(res, 200, body);
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
		}
		return true;
	}

	// ── GET /api/wiki/topic/:topicId ─────────────────────────────────
	const topicMatch =
		req.method === "GET" ? url.match(/^\/api\/wiki\/topic\/([^/?]+)$/) : null;
	if (topicMatch) {
		const topicId = decodeSegment(topicMatch[1]);
		if (topicId === null) {
			sendJson(res, 400, { error: "malformed_topic_id" });
			return true;
		}
		try {
			const store = createTopicStore(ctx.stateDir);
			const topic = store.getTopics().find((t) => t.id === topicId);
			if (!topic) {
				sendJson(res, 404, { error: "topic_not_found" });
				return true;
			}
			const members = store.getMemoriesForTopic(topicId, 200);
			const content = memberContent(ctx, members);
			const getText = (memId: string): string => content.get(memId)?.text ?? "";
			const summary = extractiveSummary(topic, members, getText);
			const present = members.filter((m) => content.has(m.memoryId));
			const keyMemories = [...present]
				.sort(
					(a, b) =>
						(content.get(b.memoryId)?.text.length ?? 0) -
						(content.get(a.memoryId)?.text.length ?? 0),
				)
				.slice(0, 10)
				.map((m) => ({
					memoryId: m.memoryId,
					content: content.get(m.memoryId)?.text ?? "",
					timestamp: content.get(m.memoryId)?.timestamp ?? 0,
					importance: Math.round(
						(content.get(m.memoryId)?.text.length ?? 0) / 40,
					),
				}));
			const relatedTopicIds = store
				.getTopics()
				.filter((t) => t.id !== topicId && t.memoryCount > 0)
				.slice(0, 3)
				.map((t) => t.id);
			const body: WikiPageResponse = {
				topic: toIndexEntry(topic, createWikiCuration(ctx.stateDir)),
				summary,
				keyMemories,
				provenance: members.map(toProvenance),
				relatedTopicIds,
				generatedAt: Date.now(),
			};
			sendJson(res, 200, body);
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
		}
		return true;
	}

	// ── PUT /api/wiki/topic/:topicId/label ───────────────────────────
	const renameMatch =
		req.method === "PUT"
			? url.match(/^\/api\/wiki\/topic\/([^/?]+)\/label$/)
			: null;
	if (renameMatch) {
		readJsonBody(req, (result) => {
			if (!result.ok) return sendJson(res, 400, { error: result.error });
			const topicId = decodeSegment(renameMatch[1]);
			if (topicId === null) return sendJson(res, 400, { error: "malformed_topic_id" });
			const label = typeof result.value.label === "string" ? result.value.label : "";
			try {
				const curation = createWikiCuration(ctx.stateDir);
				const out = curation.renameTopic(topicId, label);
				if (!out.ok) return sendJson(res, 404, { error: "topic_not_found" });
				emitWikiEvent(ctx, {
					type: "wiki_topic_renamed",
					topicId,
					label: out.label,
					edited: out.edited,
				});
				sendJson(res, 200, out satisfies CurationResult);
			} catch (e) {
				sendJson(res, 500, { error: String(e) });
			}
		});
		return true;
	}

	// ── POST /api/wiki/merge ─────────────────────────────────────────
	if (req.method === "POST" && url === "/api/wiki/merge") {
		readJsonBody(req, (result) => {
			if (!result.ok) return sendJson(res, 400, { error: result.error });
			const sourceTopicId =
				typeof result.value.sourceTopicId === "string"
					? result.value.sourceTopicId
					: "";
			const targetTopicId =
				typeof result.value.targetTopicId === "string"
					? result.value.targetTopicId
					: "";
			if (!sourceTopicId || !targetTopicId) {
				return sendJson(res, 400, { error: "missing_source_or_target" });
			}
			try {
				const curation = createWikiCuration(ctx.stateDir);
				const out = curation.mergeTopics(sourceTopicId, targetTopicId);
				if (!out.ok) {
					return sendJson(res, 400, {
						error:
							sourceTopicId === targetTopicId
								? "cannot_merge_into_itself"
								: "topic_not_found",
					});
				}
				emitWikiEvent(ctx, {
					type: "wiki_topics_merged",
					sourceTopicId,
					targetTopicId,
				});
				sendJson(res, 200, out satisfies CurationResult);
			} catch (e) {
				sendJson(res, 500, { error: String(e) });
			}
		});
		return true;
	}

	// ── POST /api/wiki/topic/:topicId/split ──────────────────────────
	const splitMatch =
		req.method === "POST"
			? url.match(/^\/api\/wiki\/topic\/([^/?]+)\/split$/)
			: null;
	if (splitMatch) {
		readJsonBody(req, (result) => {
			if (!result.ok) return sendJson(res, 400, { error: result.error });
			const topicId = decodeSegment(splitMatch[1]);
			if (topicId === null) return sendJson(res, 400, { error: "malformed_topic_id" });
			const raw = result.value.memoryIds;
			const memoryIds = Array.isArray(raw)
				? raw.filter((m): m is string => typeof m === "string")
				: [];
			if (memoryIds.length === 0) {
				return sendJson(res, 400, { error: "empty_memoryIds" });
			}
			try {
				const curation = createWikiCuration(ctx.stateDir);
				const out = curation.splitTopic(topicId, memoryIds);
				if (!out.ok) return sendJson(res, 404, { error: "topic_not_found" });
				emitWikiEvent(ctx, {
					type: "wiki_topic_split",
					fromTopicId: topicId,
					toTopicId: out.topicId,
				});
				sendJson(res, 200, out satisfies CurationResult);
			} catch (e) {
				sendJson(res, 500, { error: String(e) });
			}
		});
		return true;
	}

	return false;
}
