/**
 * cluster.ts — S51A k-means topic clustering over real stored embeddings.
 *
 * Host-agnostic (no pi imports), pure local math (PREVENT-PI-004): clusters the
 * real `context_chunks.embedding_blob` vectors with k-means++ (reused from
 * src/dedup/raptor/kmeans.ts), picks k by a real criterion (elbow on WCSS, or
 * silhouette when the corpus is large enough), and labels each cluster with the
 * top TF-IDF terms of its real member text. Pure math only — no model calls,
 * no network, no remote service (PREVENT-PI-004).
 *
 * The topic view is derived + read-only over `context_chunks` — building a model
 * never mutates any memory (PREVENT-PI-001/002). Parameterized SQL (PREVENT-002).
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "../embedder.js";
import { decodeEmbedding } from "../store/sqlite/utils.js";
import {
	tfidfScores,
	labelFromScores,
	membershipConfidence,
} from "./labels.js";
import { selectK, type Candidate } from "./kselection.js";
import type {
	ClusterModel,
	EmbeddedChunk,
	Topic,
	TopicAssignment,
} from "./types.js";

/** Config surface for clustering (host supplies; see src/config/dedup.ts in S51B). */
export interface WikiClusterConfig {
	/** [minK, maxK] search space for k selection. Default [3, 15]. */
	kRange: [number, number];
	/** How many TF-IDF terms form a label. Default 5. */
	labelTopTerms: number;
	/** k-means restarts per k (keep lowest WCSS). Default 5. */
	restarts: number;
	/** PRNG seed base for deterministic clustering. Default fixed. */
	seed: number;
}

export const DEFAULT_CLUSTER_CONFIG: WikiClusterConfig = {
	kRange: [3, 15],
	labelTopTerms: 5,
	restarts: 5,
	seed: 0x9e3779b9,
};

interface ChunkRow {
	id: string;
	session_id: string;
	embedding_blob: Uint8Array | null;
	text: string | null;
}

/**
 * Load chunks that have a usable embedding. Text is the best-available surface
 * (normalized_text → summary → topic_summary). Skips rows with no embedding or
 * no text. Returns in stable (session_id, id) order for determinism.
 */
export function loadEmbeddings(mainDb: DatabaseSync): EmbeddedChunk[] {
	const rows = mainDb
		.prepare(
			`SELECT id, session_id, embedding_blob,
              COALESCE(normalized_text, summary, topic_summary) AS text
       FROM context_chunks
       WHERE embedding_blob IS NOT NULL
       ORDER BY session_id ASC, id ASC`,
		)
		.all() as unknown as ChunkRow[];
	const out: EmbeddedChunk[] = [];
	for (const r of rows) {
		const vec = decodeEmbedding(r.embedding_blob);
		if (vec.length === 0) continue;
		const text = (r.text ?? "").trim();
		if (text.length === 0) continue;
		out.push({ chunkId: r.id, sessionId: r.session_id, vec, text });
	}
	return out;
}

/**
 * Build a topic model from the real stored chunks. Picks k by silhouette when
 * computable, else elbow; degenerate/small corpus → single `general` cluster.
 * Never throws on degenerate input — returns the safe single-cluster model.
 *
 * When `source` is provided, uses those pre-loaded EmbeddedChunks instead of
 * reading from `mainDb` (used by D1 seed path from raw_transcript). Source can
 * be partial — the function still falls back to mainDb for additional chunks
 * when source is non-empty but mainDb also has rows. Default behavior unchanged
 * when source is omitted (backward-compatible).
 */
export function buildTopicModel(
	mainDb: DatabaseSync,
	cfg: WikiClusterConfig = DEFAULT_CLUSTER_CONFIG,
	source?: EmbeddedChunk[],
): ClusterModel {
	const builtAt = Date.now();
	const chunks =
		source !== undefined && source.length > 0
			? source
			: loadEmbeddings(mainDb);
	const totalChunks = chunks.length;

	// Too small to cluster meaningfully → single general cluster.
	if (totalChunks < Math.max(2, cfg.kRange[0])) {
		return singleClusterModel(chunks, builtAt, cfg);
	}

	const points = chunks.map((c) => c.vec);
	const [minK, maxK] = cfg.kRange;
	const hi = Math.min(maxK, Math.max(minK, Math.floor(totalChunks / 2)));
	const ks: number[] = [];
	for (let k = minK; k <= hi; k++) ks.push(k);
	if (ks.length === 0) ks.push(minK);

	const { candidate: chosen, criterion } = selectK(points, ks, cfg);
	const meanSil = chosen.silhouette;
	return assembleModel(chunks, chosen, criterion, meanSil, builtAt, cfg);
}

/** Single `general` cluster holding every chunk (degenerate/small corpus). */
function singleClusterModel(
	chunks: EmbeddedChunk[],
	builtAt: number,
	cfg: WikiClusterConfig,
): ClusterModel {
	const topic: Topic = {
		id: "topic_0",
		label: labelFromScores(tfidfScores(chunks, chunks), cfg.labelTopTerms),
		termScores: tfidfScores(chunks, chunks),
		memoryCount: chunks.length,
		lastUpdated: builtAt,
	};
	const assignments: TopicAssignment[] = chunks.map((c) => ({
		memoryId: c.chunkId,
		sessionId: c.sessionId,
		topicId: "topic_0",
		confidence: 1,
		assignedAt: builtAt,
		method: "kmeans+tfidf",
	}));
	return {
		topics: chunks.length > 0 ? [topic] : [],
		assignments,
		k: chunks.length > 0 ? 1 : 0,
		criterion: "elbow",
		silhouetteScore: null,
		totalChunks: chunks.length,
		builtAt,
	};
}

/** Assemble topics + assignments from a chosen clustering. */
function assembleModel(
	chunks: EmbeddedChunk[],
	chosen: Candidate,
	criterion: "elbow" | "silhouette",
	meanSil: number | null,
	builtAt: number,
	cfg: WikiClusterConfig,
): ClusterModel {
	const topics: Topic[] = [];
	const assignments: TopicAssignment[] = [];
	for (let c = 0; c < chosen.k; c++) {
		const members = chunks.filter((_, i) => chosen.assignments[i] === c);
		if (members.length === 0) continue;
		const id = `topic_${topics.length}`;
		const scores = tfidfScores(members, chunks);
		topics.push({
			id,
			label: labelFromScores(scores, cfg.labelTopTerms),
			termScores: scores,
			memoryCount: members.length,
			lastUpdated: builtAt,
		});
	}
	for (let i = 0; i < chunks.length; i++) {
		const cluster = chosen.assignments[i];
		const centroid = chosen.centroids[cluster];
		const sim = centroid ? cosineSimilarity(chunks[i].vec, centroid) : 0;
		assignments.push({
			memoryId: chunks[i].chunkId,
			sessionId: chunks[i].sessionId,
			topicId: `topic_${cluster}`,
			confidence: membershipConfidence(sim),
			assignedAt: builtAt,
			method: "kmeans+tfidf",
		});
	}
	return {
		topics,
		assignments,
		k: topics.length,
		criterion,
		silhouetteScore: meanSil,
		totalChunks: chunks.length,
		builtAt,
	};
}
