/**
 * sources.ts — D3 data-source builders for the memory graph.
 *
 * Thin pointer: each source builder (checkpoint, turn, turn-content, memory) plus
 * RAPTOR annotation, edge dedup, and feature flags lives in ./sources/* to keep
 * this file (and every impl file) under the 500-line limit. The full public API
 * is re-exported here so existing callers importing "./memoryGraph/sources.js"
 * are unchanged.
 */
export {
  areTurnsEnabled,
  isTurnContentEnabled,
  isTurnContentFlaggedOn,
  areMemoriesEnabled,
} from "./sources/flags.js";
export { buildCheckpointNodes } from "./sources/checkpoints.js";
export {
  buildTurnNodes,
  buildTurnContentNodes,
} from "./sources/turns.js";
export { buildMemoryNodes } from "./sources/memories.js";
export { addRaptorAnnotations } from "./sources/raptor.js";
export { deduplicateEdges } from "./sources/edges.js";
