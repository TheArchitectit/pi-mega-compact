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
import { extractiveSummarize } from "./extractive.js";
import { estimateSessionTokens, estimateBlockTokens } from "./tokens.js";
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
  /** When true (default), use extractive summary instead of raw concatenation. */
  useExtractiveSummary?: boolean;
}

export interface CompactResult {
  /** True when nothing was compacted (slice empty / below floor). */
  skipped: boolean;
  /** True when the region was a duplicate of an already-stored checkpoint. */
  deduped: boolean;
  /** Which dedup tier matched: regionHash | summaryHash | contentSimilarity. */
  dedupReason?: string;
  checkpointId?: string;
  summary: string;
  regionHash: string;
  tokenEstimate: number;
  /** Files touched by the compacted region (surfaced to the UI for a live
   *  "compressing <file>" activity line). May be empty if not captured. */
  filesModified: string[];
  /** Token count of the original dropped region (before compaction). The honest
   *  "tokens saved" base = originalTokenEstimate − tokenEstimate (stored), or the
   *  full originalTokenEstimate when the region deduped onto an existing
   *  checkpoint (nothing new stored). */
  originalTokenEstimate: number;
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
      filesModified: [],
      originalTokenEstimate: 0,
      compactedFrom,
    };
  }

  // LAYER 1 — SUPERSEDE: zero-cost factual pruning of obsolete file reads.
  const supersededIdx = new Set(findSuperseded(compactable));
  const keep = compactable.filter((_m, i) => !supersededIdx.has(i));

  // LAYER 2 — COLLAPSE: build (or accept) the summary.
  // When useExtractiveSummary is enabled (default), use the deterministic
  // extractive engine that compresses ~70K tokens → ~2K tokens with structured
  // fields populated. Falls back to legacy concatenation when disabled.
  const useExtractive = input.useExtractiveSummary !== false;
  let summary: string;
  let topicSummary: string | undefined;
  let keyDecisions: string[];
  let nextSteps: string[];
  let filesModified: string[];

  if (useExtractive && !input.summary) {
    const ext = extractiveSummarize(keep);
    summary = ext.topicSummary;
    topicSummary = ext.topicSummary;
    keyDecisions = input.keyDecisions ?? ext.keyDecisions;
    nextSteps = input.nextSteps ?? ext.nextSteps;
    filesModified = input.filesModified ?? ext.filesModified;
  } else {
    const collapsed = input.summary ?? summarizeMessages(keep);
    summary = formatCompactSummary(collapsed);
    topicSummary = undefined;
    keyDecisions = input.keyDecisions ?? [];
    nextSteps = input.nextSteps ?? [];
    filesModified = input.filesModified ?? [];
  }

  // Honest "tokens saved" accounting:
  //  - originalTokenEstimate = the dropped region's token count (what context
  //    held before compaction) = the compacted slice's tokens.
  //  - storedTokens = the persisted summary's token count, computed from the
  //    actual summary string so it's honest for BOTH the extractive and legacy
  //    COLLAPSE paths (the legacy path's fallback estimateSessionTokens is the
  //    *original* size, not the stored size).
  const originalTokenEstimate = estimateSessionTokens(compactable);
  const storedTokens = estimateBlockTokens(summary);

  // Region text = the compacted slice, used for dedup + embedding.
  const regionText = input.regionText ?? keep.map((m) => m.text).join("\n");
  const regionHash = computeRegionHash(regionText);

  const add = store.add({
    sessionId: input.sessionId,
    summary,
    topicSummary,
    keyDecisions,
    nextSteps,
    filesModified,
    regionText,
    tokenEstimate: storedTokens,
    originalTokenEstimate,
    timestamp: input.timestamp ?? 0,
  });

  return {
    skipped: false,
    deduped: add.deduped,
    dedupReason: add.reason,
    checkpointId: add.checkpoint.checkpointId,
    summary,
    regionHash,
    tokenEstimate: storedTokens,
    filesModified,
    originalTokenEstimate,
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
