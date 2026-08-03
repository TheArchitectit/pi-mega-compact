/**
 * routes-wiki-helpers.ts — shared read/build helpers for routes-wiki.ts.
 *
 * Content access, index-entry resolution, provenance + time-bucket builders,
 * lazy topic-model build, and SSE emission. Kept out of the dispatcher so
 * routes-wiki.ts stays a thin pointer. Loopback-only (PREVENT-PI-004),
 * parameterized (PREVENT-002).
 */

import { appendFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { RouteContext } from "./routes-core.js";
import { openStore } from "../../src/store/sqlite.js";
import { createTopicStore } from "../../src/topics/store.js";
import { buildTopicModel } from "../../src/topics/cluster.js";
import { createWikiCuration } from "../../src/wiki/curation.js";
import type { TopicAssignment, Topic } from "../../src/topics/types.js";
import type {
	WikiIndexEntry,
	MemoryProvenance,
} from "./api-contracts/wiki.js";

/** Append a JSONL SSE line to events.log (best-effort, non-fatal). */
export function emitWikiEvent(
	ctx: RouteContext,
	event: { type: string } & Record<string, unknown>,
): void {
	try {
		appendFileSync(
			ctx.eventsPath,
			JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
		);
	} catch {
		/* non-fatal: SSE push best-effort */
	}
}

/** Lazy-build the topic model when the topics table is empty (best-effort). */
export function ensureWikiBuilt(ctx: RouteContext, tdb: DatabaseSync): void {
	const topicCount = (
		tdb.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }
	).c;
	if (topicCount > 0) return;
	try {
		const mainDb = openStore(ctx.stateDir);
		const model = buildTopicModel(mainDb);
		if (model.k > 0 && model.totalChunks > 0) {
			createTopicStore(ctx.stateDir).replaceTopicModel(model);
		}
	} catch {
		/* non-fatal: lazy wiki build is best-effort */
	}
}

/** Build a topic index entry with resolved label + override badges. */
export function toIndexEntry(
	topic: Topic,
	curation: ReturnType<typeof createWikiCuration>,
): WikiIndexEntry {
	const resolved = curation.resolveLabel(topic.id, topic.label);
	return {
		id: topic.id,
		label: resolved.label,
		memoryCount: topic.memoryCount,
		lastUpdated: topic.lastUpdated,
		edited: resolved.edited,
		overrideKinds: curation.overrideKinds(topic.id),
	};
}

/** Convert a member assignment into contract provenance. */
export function toProvenance(member: TopicAssignment): MemoryProvenance {
	return {
		memoryId: member.memoryId,
		sessionId: member.sessionId ?? "",
		assignedAt: member.assignedAt,
		method: member.method,
	};
}

/** Bucket epoch-ms values by day; returns ascending [{bucket, count}]. */
export function bucketize(
	values: number[],
): Array<{ bucket: number; count: number }> {
	const DAY = 86_400_000;
	const counts = new Map<number, number>();
	for (const v of values) {
		if (!Number.isFinite(v) || v <= 0) continue;
		const b = Math.floor(v / DAY) * DAY;
		counts.set(b, (counts.get(b) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([bucket, count]) => ({ bucket, count }));
}

/** Fetch member content (text + timestamp) from the main DB. */
export function memberContent(
	ctx: RouteContext,
	members: TopicAssignment[],
): Map<string, { text: string; timestamp: number }> {
	const out = new Map<string, { text: string; timestamp: number }>();
	if (members.length === 0) return out;
	try {
		const mainDb = openStore(ctx.stateDir);
		for (const m of members) {
			const row = mainDb
				.prepare(
					`SELECT COALESCE(normalized_text, summary, topic_summary) AS text, timestamp
					 FROM context_chunks WHERE session_id = ? AND id = ?`,
				)
				.get(m.sessionId ?? "", m.memoryId) as
				| { text: string | null; timestamp: number | null }
				| undefined;
			if (row) {
				out.set(m.memoryId, {
					text: (row.text ?? "").trim(),
					timestamp: row.timestamp ?? 0,
				});
			}
		}
	} catch {
		/* content fetch is best-effort */
	}
	return out;
}
