/**
 * recall/types.ts — shared types for the Layer-5 recall/inject pipeline.
 *
 * Lives under src/recall/ so recall.ts (the public pointer) stays a thin shell;
 * every public recall entry point ships its options/result contracts in one
 * cohesive types module.
 */
import type { SearchHit } from "../vectorStore.js";

export type RecallSource = "resume" | "command" | "sentinel";

export interface RecallInjectOptions {
	sessionId: string;
	query: string;
	limit?: number;
	source: RecallSource;
	/** Skip checkpoints already injected this session (recall dedup). */
	skipInjected?: boolean;
	/** Token ceiling for the re-injected block (Fix C). Recall stops adding once
	 *  the block would exceed this, so the read path can never net-inflate. */
	recallMaxTokens?: number;
	/** Inline-dedupe hits against the live window (Fix C): drop a hit whose
	 *  summary is ≥ `dedupSim` similar to a live message. */
	windowDedupe?: boolean;
	/** Live window text (from the session manager) used for inline dedupe. */
	liveWindow?: string[];
	/** Similarity threshold for inline dedupe (defaults to 0.9). */
	dedupSim?: number;
	/** S18: index dir of the machine-wide injected-set. When set on a cross-repo
	 *  recall, a foreign checkpoint already injected (in any session) is skipped
	 *  and a fresh injection is recorded globally. */
	globalIndexDir?: string;
	/** S25 Phase-2: also inject top-level RAPTOR summary nodes (root + level-1
	 *  clusters) as a hierarchical overview HEADER on the recall block. Defaults
	 *  to the `RAPTOR_INJECT_SUMMARIES` config flag. The overview helps the model
	 *  see the session's topical structure before the detailed checkpoint hits. */
	raptorSummaries?: boolean;
}

export interface RecallInjectResult {
	/** Blocks that are ready to inline (already deduped against the window). */
	toInject: SearchHit[];
	/** Human-readable lines for status/notify reporting. */
	report: string[];
	/** The concatenated, model-visible recall block (empty when nothing new). */
	block: string;
	/** True when nothing new was inlined. */
	empty: boolean;
}

export interface MemoryRecallInjectOptions {
	query: string;
	stateDir: string;
	limit?: number;
	/** Token ceiling; defaults to the same `recallMaxTokens` used for checkpoints. */
	recallMaxTokens?: number;
	/** Cosine threshold; default 0.2. */
	minSimilarity?: number;
	/** When true, augment same-repo recall with cross-repo PGlite NN (S24). */
	crossRepo?: boolean;
	/** Stricter cosine floor for cross-repo memory hits (S24). Default 0.3. */
	crossRepoCosine?: number;
}
