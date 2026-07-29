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
import { cosineSimilarity, type Vector } from "../embedder.js";
import { kmeanspp, cosineDistance, meanVector } from "../dedup/raptor/kmeans.js";
import { decodeEmbedding } from "../store/sqlite/utils.js";
import { tfidfScores, labelFromScores, membershipConfidence } from "./labels.js";
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

/** Within-cluster sum of squares (cosine distance) for one clustering. */
function wcss(points: Vector[], assignments: number[], centroids: Vector[]): number {
	let s = 0;
	for (let i = 0; i < points.length; i++) {
		const d = cosineDistance(points[i], centroids[assignments[i]]);
		s += d * d;
	}
	return s;
}

/** Mean silhouette score across all points (−1..1); null when undefined (k<=1 or k>=n). */
function silhouette(points: Vector[], assignments: number[], k: number): number | null {
	const n = points.length;
	if (k <= 1 || k >= n) return null;
	// Precompute cluster sizes once.
	const sizes = new Map<number, number>();
	for (const a of assignments) sizes.set(a, (sizes.get(a) ?? 0) + 1);
	let sum = 0;
	let counted = 0;
	for (let i = 0; i < n; i++) {
		const a = assignments[i];
		const ownSize = sizes.get(a) ?? 0;
		if (ownSize <= 1) continue; // singleton cluster → contribution 0 (skip)
		let aSum = 0;
		const bSum = new Map<number, number>();
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const d = cosineDistance(points[i], points[j]);
			if (assignments[j] === a) {
				aSum += d;
			} else {
				bSum.set(assignments[j], (bSum.get(assignments[j]) ?? 0) + d);
			}
		}
		const aMean = aSum / (ownSize - 1); // exclude self
		let b = Infinity;
		for (const [cluster, total] of bSum) {
			const cnt = sizes.get(cluster) ?? 0;
			if (cnt > 0) b = Math.min(b, total / cnt);
		}
		if (!Number.isFinite(b)) continue;
		const denom = Math.max(aMean, b);
		if (denom > 0) {
			sum += (b - aMean) / denom;
			counted++;
		}
	}
	return counted > 0 ? sum / counted : null;
}

/** Elbow: index of max curvature on the WCSS-vs-k curve. */
function elbowIndex(ks: number[], wcssVals: number[]): number {
	if (ks.length <= 2) return 0;
	// Normalize and find the point farthest from the line joining the endpoints.
	const x0 = ks[0];
	const y0 = wcssVals[0];
	const x1 = ks[ks.length - 1];
	const y1 = wcssVals[wcssVals.length - 1];
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len = Math.hypot(dx, dy) || 1;
	let best = 0;
	let bestDist = -1;
	for (let i = 0; i < ks.length; i++) {
		const dist = Math.abs(dy * ks[i] - dx * wcssVals[i] + x1 * y0 - y1 * x0) / len;
		if (dist > bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

interface Candidate {
	k: number;
	assignments: number[];
	centroids: Vector[];
	wcss: number;
	silhouette: number | null;
}

/** Run k-means with restarts for one k; keep the lowest-WCSS result. */
function bestForK(points: Vector[], k: number, cfg: WikiClusterConfig): Candidate {
	let best: Candidate | null = null;
	for (let r = 0; r < cfg.restarts; r++) {
		const res = kmeanspp(points, k, { seed: cfg.seed + r });
		if (res.k === 0) continue;
		const w = wcss(points, res.assignments, res.centroids);
		if (!best || w < best.wcss) {
			best = {
				k: res.k,
				assignments: res.assignments,
				centroids: res.centroids,
				wcss: w,
				silhouette: null,
			};
		}
	}
	// Degenerate: kmeans collapsed everything to < k clusters.
	if (!best) {
		const mean = meanVector(points);
		best = { k: 1, assignments: points.map(() => 0), centroids: [mean], wcss: 0, silhouette: null };
	}
	best.silhouette = silhouette(points, best.assignments, best.k);
	return best;
}

/**
 * Build a topic model from the real stored chunks. Picks k by silhouette when
 * computable, else elbow; degenerate/small corpus → single `general` cluster.
 * Never throws on degenerate input — returns the safe single-cluster model.
 */
export function buildTopicModel(
	mainDb: DatabaseSync,
	cfg: WikiClusterConfig = DEFAULT_CLUSTER_CONFIG,
): ClusterModel {
	const builtAt = Date.now();
	const chunks = loadEmbeddings(mainDb);
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

	const candidates = ks.map((k) => bestForK(points, k, cfg));

	// Prefer silhouette when any candidate produced a computable score.
	const withSil = candidates.filter((c) => c.silhouette !== null);
	let chosen: Candidate;
	let criterion: "elbow" | "silhouette";
	if (withSil.length > 0) {
		chosen = withSil.reduce((a, b) => ((b.silhouette ?? -1) > (a.silhouette ?? -1) ? b : a));
		criterion = "silhouette";
	} else {
		const idx = elbowIndex(
			candidates.map((c) => c.k),
			candidates.map((c) => c.wcss),
		);
		chosen = candidates[idx];
		criterion = "elbow";
	}

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
