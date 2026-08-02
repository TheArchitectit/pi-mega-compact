/**
 * types.ts — VectorStore public types + constants (extracted from vectorStore.ts).
 */
import type { StoredCheckpoint } from "../store.js";

export interface SearchHit {
	checkpoint: StoredCheckpoint;
	score: number;
	/** Source repo id (the foreign repo's stateDir) for cross-repo hits, set by
	 *  `searchAsync` so the recall block can label foreign checkpoints. Undefined
	 *  for same-repo hits (the default path). */
	repoId?: string;
	/** S42B: when set, this hit is a RAPTOR cluster node (not a stored checkpoint).
	 *  The recall block uses `raptorSummary` instead of checkpoint.summary. */
	raptorSummary?: string;
	/** S42B: the tree level of the cluster node (0 = leaves, 1+ = internal). */
	raptorLevel?: number;
}

export interface AddInput {
	sessionId: string;
	summary: string;
	/** Compressed topic summary (extractive). When present, embedded instead of regionText. */
	topicSummary?: string;
	keyDecisions?: string[];
	nextSteps?: string[];
	filesModified?: string[];
	tokenEstimate?: number;
	/** Token count of the ORIGINAL dropped region (before compaction). Drives the
	 *  honest "tokens saved" = originalTokenEstimate − tokenEstimate (stored), or
	 *  the full originalTokenEstimate when the region dedups (nothing new stored).
	 *  Optional for back-compat with direct add() callers; defaults to stored. */
	originalTokenEstimate?: number;
	/** Raw text of the compacted region — used to derive the regionHash + vector. */
	regionText: string;
	timestamp: number;
	/** Sync progress callback fired as each dedup tier is evaluated (L0→L1→L2→new).
	 *  Lets the UI render live per-tier progress during compaction. Never awaited;
	 *  must be cheap. Optional for back-compat. */
	onTier?: (ev: {
		tier: "L0" | "L1" | "L2" | "new";
		status: "scanning" | "deduped" | "passed" | "stored";
		detail?: string;
	}) => void;
	/** Context-window pressure (0–1) — escalates the stored checkpoint's sync
	 *  compression strength (Fix E). Optional; defaults to 0 (brotli-4). */
	compressionPressure?: number;
}

/** Default L2 semantic-dedup enable flag (trigram embedder is local, zero-network). */
export const L2_ENABLED = true;

export interface AddResult {
	checkpoint: StoredCheckpoint;
	deduped: boolean; // true when an equivalent region already existed (skipped embed)
	/** Which dedup tier matched: regionHash | summaryHash | contentSimilarity | undefined (new). */
	reason?: string;
}
