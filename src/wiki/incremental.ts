/**
 * incremental.ts — W5 incremental topic assignment (feature B).
 *
 * Instead of rebuilding the whole topic model on every Nth compaction, assign
 * only the NEW memory chunks to their nearest existing topic centroid. Keeps
 * user curation (rename / merge / split topics) stable far longer, so the full
 * override replay (topics/durability.ts) is needed less often. Tracks the mean
 * silhouette over the current assignments and signals a full rebuild when it
 * degrades below a configurable threshold.
 *
 * Host-agnostic (no pi imports), pure local node:sqlite (PREVENT-PI-004), all
 * SQL parameterized (PREVENT-002). Best-effort + non-fatal: a failure never
 * breaks the agent loop.
 */
import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "../embedder.js";
import { loadEmbeddings } from "../topics/cluster.js";
import { silhouette } from "../topics/kselection.js";
import { openTurnStore, withTx } from "../store/turns/connection.js";

/** Result of one incremental assignment pass. */
export interface IncrementalAssignResult {
	/** Number of new memories assigned to a topic. */
	assigned: number;
	/** Number of unassigned memories that didn't clear the similarity floor. */
	pending: number;
	/** Mean silhouette over current assignments; null when non-computable. */
	silhouette: number | null;
}

/** Min cosine to a centroid before a chunk is admitted to a topic. */
const ASSIGN_SIM_FLOOR = 0.3;

interface AssignmentRow {
	memory_id: string;
	topic_id: string;
}

/** Average of vectors → the centroid for a topic's current members. */
function meanOf(vectors: number[][]): number[] {
	const dim = vectors[0]?.length ?? 0;
	const centroid = new Array<number>(dim).fill(0);
	for (const v of vectors) {
		for (let i = 0; i < dim; i++) centroid[i] += v[i];
	}
	return centroid.map((x) => x / Math.max(1, vectors.length));
}

/**
 * Assign new memories (not already in memory_topics) to their nearest existing
 * topic centroid without a full rebuild. `db` is the main memory store whose
 * `context_chunks` holds the embeddings; `stateDir` locates the turns.db where
 * `topics` / `memory_topics` live. Writes are best-effort + non-fatal.
 */
export function assignNewMemoriesIncremental(
	db: DatabaseSync,
	stateDir: string,
): IncrementalAssignResult {
	const result: IncrementalAssignResult = {
		assigned: 0,
		pending: 0,
		silhouette: null,
	};
	try {
		const turnDb = openTurnStore(stateDir);
		const assignedRows = turnDb
			.prepare(
				"SELECT memory_id, topic_id FROM memory_topics",
			)
			.all() as unknown as AssignmentRow[];

		const chunks = loadEmbeddings(db);
		if (chunks.length === 0) return result;

		// Map memory_id → chunk for both centroid build + unassigned scan.
		const chunkById = new Map<string, (typeof chunks)[number]>();
		for (const c of chunks) chunkById.set(c.chunkId, c);

		const assignedIds = new Set(assignedRows.map((r) => r.memory_id));
		const centroids = new Map<string, number[]>();
		// Accumulate real member vectors per topic from assigned, embedded chunks.
		const byTopic = new Map<string, number[][]>();
		for (const r of assignedRows) {
			const c = chunkById.get(r.memory_id);
			if (!c) continue;
			const list = byTopic.get(r.topic_id) ?? [];
			list.push(c.vec);
			byTopic.set(r.topic_id, list);
		}
		for (const [topicId, vecs] of byTopic) {
			if (vecs.length > 0) centroids.set(topicId, meanOf(vecs));
		}

		// Assign unassigned chunks to the nearest non-empty centroid.
		const assignmentsToWrite = new Map<string, string>();
		for (const c of chunks) {
			if (assignedIds.has(c.chunkId)) continue;
			let bestTopic = "";
			let bestSim = ASSIGN_SIM_FLOOR;
			for (const [topicId, centroid] of centroids) {
				const sim = cosineSimilarity(c.vec, centroid);
				if (sim > bestSim) {
					bestSim = sim;
					bestTopic = topicId;
				}
			}
			if (bestTopic) {
				assignmentsToWrite.set(c.chunkId, bestTopic);
			} else {
				result.pending++;
			}
		}

		// Persist new assignments atomically + best-effort.
		if (assignmentsToWrite.size > 0) {
			try {
				withTx(turnDb, () => {
					const ins = turnDb.prepare(
						`INSERT OR REPLACE INTO memory_topics
						   (memory_id, topic_id, confidence, assigned_at, method, session_id)
						 VALUES (?, ?, ?, ?, 'kmeans+tfidf', ?)`,
					);
					const now = Date.now();
					for (const [memoryId, topicId] of assignmentsToWrite) {
						const cent = centroids.get(topicId);
						const c = chunkById.get(memoryId);
						const sim = cent && c ? cosineSimilarity(c.vec, cent) : 0;
						ins.run(memoryId, topicId, sim, now, c?.sessionId ?? null);
					}
				});
				result.assigned = assignmentsToWrite.size;
			} catch {
				/* non-fatal: assignment write failure never breaks the loop */
			}
		}

		// Compute mean silhouette over current + newly assigned memberships.
		const allPoints: number[][] = [];
		const assignments: number[] = [];
		const topicIndex = new Map<string, number>();
		const lookup = new Map<string, { topic: string }>();
		for (const r of assignedRows) lookup.set(r.memory_id, { topic: r.topic_id });
		for (const c of chunks) {
			const topic = lookup.has(c.chunkId)
				? lookup.get(c.chunkId)!.topic
				: assignmentsToWrite.get(c.chunkId);
			if (!topic) continue;
			if (!topicIndex.has(topic)) topicIndex.set(topic, topicIndex.size);
			allPoints.push(c.vec);
			assignments.push(topicIndex.get(topic)!);
		}
		if (allPoints.length > 0) {
			result.silhouette = silhouette(
				allPoints,
				assignments,
				topicIndex.size,
			);
		}
		return result;
	} catch {
		/* non-fatal: incremental assignment never breaks compaction */
		return result;
	}
}
