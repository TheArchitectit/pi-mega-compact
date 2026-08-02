/**
 * vectorStore.ts — Layer 3 (CLUSTER): the local vector database.
 *
 * Thin pointer / barrel: the implementation (VectorStore class), the public
 * types, and the region-hash helper live in ./vectorStore/* to keep every file
 * under the 500-line limit. The full public API — including the read/search
 * helper re-exports — is re-exported here so existing callers importing
 * "./vectorStore.js" are unchanged.
 */
export { VectorStore } from "./vectorStore/class.js";
export { computeRegionHash } from "./vectorStore/hash.js";
export {
	L2_ENABLED,
	type SearchHit,
	type AddInput,
	type AddResult,
} from "./vectorStore/types.js";

// Re-exports (back-compat): existing call sites keep importing from "./vectorStore.js"
export {
	vectorSemDedup,
	vectorDedupe,
	vectorMarkInjected,
	vectorWasInjected,
	vectorSimilarity,
	vectorList,
	vectorTopSimilar,
	vectorStats,
	vectorRepoStats,
	vectorDataInvariant,
} from "./vector-read.js";

// Re-exports: vectorSearch / vectorSearchAsync (moved to vector-search.ts)
export { vectorSearch, vectorSearchAsync } from "./vector-search.js";
