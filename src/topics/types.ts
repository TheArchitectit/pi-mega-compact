/**
 * types.ts — S51A auto-categorizing wiki: shared types.
 *
 * Host-agnostic (no pi imports). These describe a derived, read-only topic view
 * over stored memory chunks — see docs/specs/s51-auto-categorizing-wiki.md and
 * the extended s47 spec. No model calls, no network (PREVENT-PI-004); pure local math.
 */

/** One derived topic cluster. */
export interface Topic {
	/** Stable cluster id (e.g. "topic_0"). */
	id: string;
	/** Human label = top TF-IDF terms joined (e.g. "sqlite · wal · checkpoint"). */
	label: string;
	/** Full sorted TF-IDF term scores for this cluster (label is the top slice). */
	termScores: Array<{ term: string; score: number }>;
	/** Number of member chunks assigned to this topic. */
	memoryCount: number;
	/** Epoch ms when this topic was (re)built. */
	lastUpdated: number;
}

/** Assignment of one memory chunk to a topic. */
export interface TopicAssignment {
	/** `context_chunks.id` (per-session). */
	memoryId: string;
	/** Owning session — `context_chunks` PK is (session_id, id). */
	sessionId: string;
	topicId: string;
	/** Normalized cosine membership in [0,1] (closer to centroid → higher). */
	confidence: number;
	/** Epoch ms when assigned. */
	assignedAt: number;
	/** Constant provenance tag. */
	method: "kmeans+tfidf";
}

/** The full derived model: k clusters + assignments + the criterion used. */
export interface ClusterModel {
	topics: Topic[];
	assignments: TopicAssignment[];
	/** Chosen cluster count (1 for a degenerate/small corpus). */
	k: number;
	/** Real criterion used to pick k. */
	criterion: "elbow" | "silhouette";
	/** Mean silhouette across clusters; null when the corpus is too small. */
	silhouetteScore: number | null;
	/** Chunks with usable embeddings that were clustered. */
	totalChunks: number;
	/** Epoch ms when built. */
	builtAt: number;
}

/** A loaded chunk ready for clustering: its embedding + best-available text. */
export interface EmbeddedChunk {
	/** `context_chunks.id`. */
	chunkId: string;
	sessionId: string;
	/** Decoded float32 embedding (L2-normalized by the embedder). */
	vec: number[];
	/** COALESCE(normalized_text, summary, topic_summary) — TF-IDF + summary source. */
	text: string;
}
