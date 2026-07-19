/**
 * mega-pipeline.ts — barrel re-export of the compaction + recall pipelines.
 *
 * Split into focused submodules under `./mega-pipeline/`:
 *   - memory-review.ts — `runMemoryReview`
 *   - compact.ts       — `runCompact`, `piCompactWouldNoop`, `RunCompactResult`
 *   - recall.ts        — `doRecall`, `doRecallAsync`
 *
 * `runCompact` runs the full Trident pipeline (fast-gate aside) and persists a
 * checkpoint. `doRecall` is the unified Layer-5 recall entry point. Both mutate
 * the shared MegaRuntime (token accounting, ticker, status, events) and are
 * driven by the event + command handlers in mega-events.ts / mega-commands.ts.
 */

export * from "./mega-pipeline/memory-review.js";
export * from "./mega-pipeline/compact.js";
export * from "./mega-pipeline/recall.js";
