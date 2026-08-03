/**
 * index.ts — wiki barrel. Re-export only; no logic.
 */
export {
	createWikiCuration,
	type WikiCurationStore,
	type OverrideKind,
	type CurationResult,
} from "./curation.js";
export {
	assignNewMemoriesIncremental,
	type IncrementalAssignResult,
} from "./incremental.js";
