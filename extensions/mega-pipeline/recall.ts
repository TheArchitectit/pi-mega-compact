/**
 * recall.ts — shell re-export for the unified Layer-5 recall pipeline (3WF-3 split).
 *
 * Delegate-shell pattern: the implementation lives in ./recall/impl.ts (kept
 * under the 300-line soft cap). All public symbols are re-exported here so
 * `export * from "./mega-pipeline/recall.js"` (mega-pipeline.ts) and any direct
 * importers keep resolving with byte-identical names.
 */

export {
	doRecall,
	doRecallAsync,
	extractLiveWindow,
} from "./recall/impl.js";
