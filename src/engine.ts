/**
 * engine.ts — Layer 4 (PERSIST / checkpoint) orchestration.
 *
 * Ties the Sprint 1–2 primitives into the compaction pipeline the extension
 * calls. Pure of any pi runtime type: it consumes EngineMessage[] and talks to
 * the on-disk VectorStore. The extension adapts pi messages -> EngineMessage
 * (see adapt.ts) and reports status.
 *
 * Pipeline (mirrors the PLAN Trident stack):
 *   SUPERSEDE (drop obsolete file reads)
 *   -> COLLAPSE (summarize the compacted slice)
 *   -> CLUSTER  (embed + persist a checkpoint to the vector store)
 */

import { findSuperseded, supersede } from "./supersede.js";
import { summarizeMessages, mergeCompactSummaries, formatCompactSummary } from "./compact.js";
import { estimateSessionTokens } from "./tokens.js";
import { computeRegionHash, VectorStore, type SearchHit } from "./vectorStore.js";
import type { EngineMessage } from "./types.js";

export interface CompactInput {
  sessionId: string;
  messages: EngineMessage[];
  /** Index (into `messages`) of the first message to keep verbatim. Everything
   *  before this is eligible to be compacted. Defaults to `preserveRecent`
   *  from the tail. */
  keepFrom?: number;
  /** Optional explicit summary; when omitted, COLLAPSE heuristics build one. */
  summary?: string;
  /** Region text the checkpoint is keyed on (for dedup). Defaults to the
   *  compacted slice's joined text. */
  regionText?: string;
  keyDecisions?: string[];
  nextSteps?: string[];
  filesModified?: string[];
  tokenEstimate?: number;
  timestamp?: number;
}

export interface CompactResult {
  /** True when nothing was compacted (slice empty / below floor). */
  skipped: boolean;
  /** True when the region was a duplicate of an already-stored checkpoint. */
  deduped: boolean;
  checkpointId?: string;
  summary: string;
  regionHash: string;
  tokenEstimate: number;
  /** Index in `messages` where the compacted slice begins (for the caller to
   *  build a drop range). */
  compactedFrom: number;
}

/** Default store used by the convenience `compactSession`. */
let defaultStore: VectorStore | undefined;
export function getDefaultStore(stateDir?: string): VectorStore {
  if (!defaultStore) defaultStore = new VectorStore({ stateDir });
  return defaultStore;
}
/** Replace the default store (used by tests to inject a temp dir). */
export function setDefaultStore(store: VectorStore | undefined): void {
  defaultStore = store;
}

/**
 * Run the Trident pipeline over a message slice and persist a checkpoint.
 *
 * `messages` is the FULL session view; `keepFrom` marks where the verbatim tail
 * starts, so indices stay absolute and the caller can map the drop range back
 * onto the real (pi) message array via adapt.ts. Returns a `skipped` result
 * when the compactable slice is empty.
 */
export function compactSession(input: CompactInput, store: VectorStore = getDefaultStore()): CompactResult {
  const keepFrom = input.keepFrom ?? input.messages.length;
  const compactable = input.messages.slice(0, keepFrom);
  const compactedFrom = keepFrom;

  if (compactable.length === 0) {
    return {
      skipped: true,
      deduped: false,
      summary: "",
      regionHash: "",
      tokenEstimate: 0,
      compactedFrom,
    };
  }

  // LAYER 1 — SUPERSEDE: zero-cost factual pruning of obsolete file reads.
  const supersededIdx = new Set(findSuperseded(compactable));
  const keep = compactable.filter((_m, i) => !supersededIdx.has(i));

  // LAYER 2 — COLLAPSE: build (or accept) the summary.
  const collapsed = input.summary ?? summarizeMessages(keep);
  const summary = formatCompactSummary(collapsed);

  // Region text = the compacted slice, used for dedup + embedding.
  const regionText = input.regionText ?? keep.map((m) => m.text).join("\n");
  const regionHash = computeRegionHash(regionText);

  const tokenEstimate =
    input.tokenEstimate ?? estimateSessionTokens(compactable);

  const add = store.add({
    sessionId: input.sessionId,
    summary,
    keyDecisions: input.keyDecisions ?? [],
    nextSteps: input.nextSteps ?? [],
    filesModified: input.filesModified ?? [],
    regionText,
    tokenEstimate,
    timestamp: input.timestamp ?? 0,
  });

  return {
    skipped: false,
    deduped: add.deduped,
    checkpointId: add.checkpoint.checkpointId,
    summary,
    regionHash,
    tokenEstimate,
    compactedFrom,
  };
}

export interface RecallInput {
  sessionId: string;
  query: string;
  limit?: number;
  /** Skip checkpoints already injected this session (recall dedup). */
  skipInjected?: boolean;
}

export interface RecallResult {
  hits: SearchHit[];
  /** Indices into `hits` that were *not* already injected (ready to inline). */
  newHits: SearchHit[];
}

/**
 * Layer 5 (query side, shared by auto-inline + on-demand): search the store and
 * drop any checkpoint already injected this session. The caller decides how to
 * inject (Sprint 4 wires injection); this module only does the deduped search.
 */
export function recall(input: RecallInput, store: VectorStore = getDefaultStore()): RecallResult {
  const hits = store.search(input.sessionId, input.query, input.limit ?? 3);
  const newHits = input.skipInjected === false ? hits : hits.filter((h) => !store.wasInjected(input.sessionId, h.checkpoint.checkpointId));
  return { hits, newHits };
}

/** Merge a freshly compacted summary into the prior persisted summary text. */
export function mergeSummary(existing: string | undefined, next: string): string {
  return mergeCompactSummaries(existing, next);
}

/** Exposed for callers that want raw supersede stats (status reporting). */
export function supersededCount(messages: EngineMessage[]): number {
  return new Set(findSuperseded(messages)).size;
}

/** Re-export so the extension has one import surface. */
export { supersede, summarizeMessages, formatCompactSummary };
