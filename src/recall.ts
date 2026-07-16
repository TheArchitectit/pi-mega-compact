/**
 * recall.ts — Layer 5 (RECALL / INLINE): the unified injection path.
 *
 * ONE vector store, THREE entry points, ONE dedup engine. Every way context
 * gets re-injected into the window (auto-inline on resume, on-demand
 * /recall-context, and the dedup sentinel) goes through `recallAndInline`.
 * It always does: search -> dedupe -> inject. The only thing that differs per
 * entry point is *what triggers it* and *what query it uses*.
 *
 * Injection respects PREVENT-PI-003: pi has no `system` message role, so we
 * prepend our recall block to the system prompt via the `before_agent_start`
 * hook's `systemPrompt` result (the extension wires that). This module is
 * pi-agnostic: it returns an injectable text block and records injections; the
 * extension decides where it lands.
 */

import { recall as searchRecall } from "./engine.js";
import type { SearchHit, VectorStore } from "./vectorStore.js";
import { estimateBlockTokens } from "./tokens.js";
import { defaultEmbedder, cosineSimilarity } from "./embedder.js";

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

/** Wrap a recall block so the model reads it as restored compacted context. */
export function formatRecallBlock(hits: SearchHit[]): string {
  if (hits.length === 0) return "";
  const parts = hits.map((h, i) => {
    const score = (h.score * 100).toFixed(0);
    // S17: label a cross-repo hit with its source repo (the repoId doubles as
    // that repo's stateDir, so the last path segment is the repo's display
    // name). Same-repo hits (no repoId) stay unlabeled.
    const repoName = h.repoId ? ` (from repo ${h.repoId.split("/").filter(Boolean).pop() ?? h.repoId})` : "";
    return (
      `### Recalled context [${i + 1}] (relevance ${score}%)${repoName}\n` +
      `${h.checkpoint.summary.trim()}\n` +
      (h.checkpoint.filesModified.length
        ? `Key files: ${h.checkpoint.filesModified.join(", ")}.\n`
        : "")
    );
  });
  return (
    "The following compacted context was recalled from earlier in this session " +
    "and is relevant to the current request. Treat it as background you already know:\n\n" +
    parts.join("\n")
  );
}

/**
 * Run the unified recall+dudupe+prepare-inject pipeline. Does NOT touch pi;
 * it records injections via `markInjected` so the next call dedupes. The
 * `store` is passed by the extension (defaults to the engine's default store).
 */
export function recallAndInline(
  opts: RecallInjectOptions,
  store: Pick<VectorStore, "search" | "wasInjected" | "markInjected">,
): RecallInjectResult {
  const limit = opts.limit ?? 3;
  const skip = opts.skipInjected ?? true;
  const maxTokens = opts.recallMaxTokens ?? 0; // 0 = unbounded (legacy behavior)
  const doWindowDedupe = opts.windowDedupe ?? false;
  const dedupSim = opts.dedupSim ?? 0.9;

  const { hits } = searchRecall(
    { sessionId: opts.sessionId, query: opts.query, limit, skipInjected: false },
    store as VectorStore,
  );

  // Precompute live-window embeddings once for inline dedupe (Fix C). Trigram
  // embedder is local + cheap; never a network call (PREVENT-PI-004).
  let liveEmbeddings: number[][] = [];
  if (doWindowDedupe && opts.liveWindow && opts.liveWindow.length > 0) {
    const embedder = defaultEmbedder();
    liveEmbeddings = opts.liveWindow.map((m) => embedder.embed(m));
  }

  // Shared dedup + bounded/inline block assembly. We build the block
  // incrementally so the token cap can stop mid-stream (Fix C).
  const toInject: SearchHit[] = [];
  const parts: string[] = [];
  let blockTokens = 0;

  for (const h of hits) {
    if (skip && store.wasInjected(opts.sessionId, h.checkpoint.checkpointId)) continue;

    // Inline dedupe: skip a hit already resident in the live window (Fix C).
    if (doWindowDedupe && liveEmbeddings.length > 0) {
      const hitVec = defaultEmbedder().embed(h.checkpoint.summary);
      if (liveEmbeddings.some((v) => cosineSimilarity(v, hitVec) >= dedupSim)) continue;
    }

    const part = formatRecallBlock([h]);
    const partTokens = estimateBlockTokens(part);
    // Token cap: never push a chunk that would overrun the ceiling.
    if (maxTokens > 0 && blockTokens + partTokens > maxTokens) break;

    parts.push(part);
    toInject.push(h);
    blockTokens += partTokens;
    store.markInjected(opts.sessionId, h.checkpoint.checkpointId);
  }

  const block = parts.join("\n");
  const report = toInject.map(
    (h) => `  • ${h.checkpoint.checkpointId} (${h.checkpoint.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
  );

  return {
    toInject,
    report,
    block,
    empty: toInject.length === 0,
  };
}

/**
 * Slice 2 async cross-repo recall. Same dedup/bound/inline contract as
 * `recallAndInline`, but backed by `VectorStore.searchAsync` so it can recall
 * across repos (HNSW NN over the global PGlite index) when `opts.crossRepo` is
 * set. The synchronous `recallAndInline` is unchanged and remains the default
 * per-session path. Inline-window dedupe + token cap (Fix C) apply here too.
 *
 * `store` must provide `searchAsync` (the live VectorStore does). Errors fall
 * back to an empty result — recall is a bonus, never a hard dependency.
 */
export async function recallAndInlineAsync(
  opts: RecallInjectOptions & { crossRepo?: boolean; repoId?: string },
  store: Pick<VectorStore, "searchAsync" | "wasInjected" | "markInjected">,
): Promise<RecallInjectResult> {
  const limit = opts.limit ?? 3;
  const skip = opts.skipInjected ?? true;
  const maxTokens = opts.recallMaxTokens ?? 0;
  const doWindowDedupe = opts.windowDedupe ?? false;
  const dedupSim = opts.dedupSim ?? 0.9;

  let hits: SearchHit[] = [];
  try {
    hits = await store.searchAsync(opts.sessionId, opts.query, limit, {
      crossRepo: opts.crossRepo,
      repoId: opts.repoId,
    });
  } catch {
    hits = [];
  }

  let liveEmbeddings: number[][] = [];
  if (doWindowDedupe && opts.liveWindow && opts.liveWindow.length > 0) {
    const embedder = defaultEmbedder();
    liveEmbeddings = opts.liveWindow.map((m) => embedder.embed(m));
  }

  const toInject: SearchHit[] = [];
  const parts: string[] = [];
  let blockTokens = 0;

  for (const h of hits) {
    if (skip && store.wasInjected(opts.sessionId, h.checkpoint.checkpointId)) continue;
    if (doWindowDedupe && liveEmbeddings.length > 0) {
      const hitVec = defaultEmbedder().embed(h.checkpoint.summary);
      if (liveEmbeddings.some((v) => cosineSimilarity(v, hitVec) >= dedupSim)) continue;
    }
    const part = formatRecallBlock([h]);
    const partTokens = estimateBlockTokens(part);
    if (maxTokens > 0 && blockTokens + partTokens > maxTokens) break;
    parts.push(part);
    toInject.push(h);
    blockTokens += partTokens;
    store.markInjected(opts.sessionId, h.checkpoint.checkpointId);
  }

  const block = parts.join("\n");
  const report = toInject.map(
    (h) => `  • ${h.checkpoint.checkpointId} (${h.checkpoint.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
  );

  return { toInject, report, block, empty: toInject.length === 0 };
}
