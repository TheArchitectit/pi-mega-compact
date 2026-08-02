/**
 * recall.ts — Layer 5 (RECALL / INLINE): the unified injection path (public
 * pointer).
 *
 * Thin shell that re-exports the recall pipeline from ./recall/*. The heavy
 * logic lives in sibling impl files (sync.ts, async.ts, memory.ts,
 * reformulate.ts, format.ts) so no single file crosses the 500-line hard
 * limit (delegate-shell pattern). All public symbols are re-exported here so
 * existing callers `import { recallAndInline } from "./recall.js"` (or
 * "../recall.js") continue to work unchanged.
 *
 * Injection respects PREVENT-PI-003: pi has no `system` message role, so we
 * prepend our recall block to the system prompt via the `before_agent_start`
 * hook's `systemPrompt` result (the extension wires that). This module is
 * pi-agnostic: it returns an injectable text block and records injections; the
 * extension decides where it lands.
 */

export { recallAndInline } from "./recall/sync.js";
export { recallAndInlineAsync } from "./recall/async.js";
export { recallMemoriesAndInline } from "./recall/memory.js";
export {
	formatRecallBlock,
	formatRaptorBlock,
	formatMemoryRecallBlock,
	raptorOverviewBlock,
	scoreAndLogRecallMetrics,
} from "./recall/format.js";
export { reformulateRecallQuery, runTieredRecall } from "./recall/reformulate.js";
export type {
	RecallSource,
	RecallInjectOptions,
	RecallInjectResult,
	MemoryRecallInjectOptions,
} from "./recall/types.js";
