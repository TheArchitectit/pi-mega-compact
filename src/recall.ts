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
import { vectorWasInjected, vectorMarkInjected, type SearchHit, type VectorStore, vectorSearchAsync } from "./vectorStore.js";
import { estimateBlockTokens } from "./tokens.js";
import { defaultEmbedder, cosineSimilarity } from "./embedder.js";
import { rehydrateRaptorTree } from "./dedup/raptor/index.js";
import { normalizeSessionId } from "./store.js";

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

/** Wrap a recall block so the model reads it as restored compacted context. */
export function formatRecallBlock(hits: SearchHit[]): string {
  if (hits.length === 0) return "";
  const parts = hits.map((h, i) => {
    const score = (h.score * 100).toFixed(0);
    // S17: label a cross-repo hit with its source repo (the repoId doubles as
    // that repo's stateDir, so the last path segment is the repo's display
    // name). Same-repo hits (no repoId) stay unlabeled.
    const repoName = h.repoId ? ` (from repo ${h.repoId.split("/").filter(Boolean).pop() ?? h.repoId})` : "";
    // S42B: a RAPTOR cluster node hit (not a stored checkpoint) is labeled as a
    // hierarchical summary and uses raptorSummary as its body. No Key files line
    // (cluster nodes carry no file list).
    if (h.raptorLevel !== undefined) {
      return (
        `### Recalled cluster summary [${i + 1}] (level ${h.raptorLevel}, relevance ${score}%)${repoName}\n` +
        `${(h.raptorSummary ?? h.checkpoint.summary).trim()}\n`
      );
    }
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
 * S25 Phase-2: format the RAPTOR tree's top-level summary nodes (root + level-1
 * clusters) as a hierarchical overview HEADER. Surfacing the high-level topical
 * structure before the detailed checkpoint hits gives the model a map of what
 * the session has covered. `nodes` are the RAPTOR summary nodes to surface,
 * highest level first (root → level-1 clusters). Returns "" when empty.
 */
export function formatRaptorBlock(
  nodes: { summary: string; level: number; score?: number }[],
): string {
  if (nodes.length === 0) return "";
  const parts = nodes.map((n, i) => {
    const score =
      n.score !== undefined ? ` (relevance ${(n.score * 100).toFixed(0)}%)` : "";
    const label =
      n.level === 0
        ? `Session overview [${i + 1}]${score}`
        : `Cluster summary [${i + 1}] (level ${n.level})${score}`;
    return `### ${label}\n${n.summary.trim()}\n`;
  });
  return (
    "The following hierarchical overview summarizes the structure of this " +
    "session so far. Use it as a map of what has been covered:\n\n" +
    parts.join("\n")
  );
}

/**
 * Run the unified recall+dudupe+prepare-inject pipeline. Does NOT touch pi;
 * it records injections via `markInjected` so the next call dedupes. The
 * `store` is passed by the extension (defaults to the engine's default store).
 */
/**
 * Recall and inline context from the checkpoint store.
 *
 * S27 contract — DB-Mirror demotion:
 *
 * When `MEGACOMPACT_DB_MIRROR` is ON, the `raw_transcript` table is the
 * canonical, byte-stable source of truth for message reconstruction. The
 * `dedup_mirror` provides space-efficient storage with ref_count tracking
 * (see src/mirror/dedup.ts). The legacy JSON checkpoint is retained as a
 * DR snapshot only (see src/store.ts checkpoint helpers).
 *
 * The recall function continues to work from the VectorStore (checkpoint
 * summaries + embeddings) for fast semantic search — this path is unaffected
 * by the mirror flag. If full transcript reconstruction is ever needed
 * (replay, export, debug), prefer reading from `raw_transcript + dedup_mirror`
 * via `listRawTranscriptRange()` + `dedupTranscript()` instead of the legacy
 * JSON checkpoint. Falls back to legacy checkpoint if mirror is empty
 * (pre-migration sessions).
 *
 * Pi-agnostic: no pi runtime imports (src/ invariant).
 */
export function recallAndInline(
  opts: RecallInjectOptions,
  store: VectorStore,
): RecallInjectResult {
  // ── S27 Recall Demotion ─────────────────────────────────────────────
  //
  // When MEGACOMPACT_DB_MIRROR is ON, the raw_transcript + dedup_mirror
  // tables are preferred for byte-stable reconstruction. The current
  // recall path (VectorStore search → format → inject) is unaffected —
  // it provides fast semantic search over checkpoint summaries.
  //
  // If full transcript reconstruction is ever needed (replay, export,
  // debug), call reconstructFromMirror(db, sessionId, fromSeq, toSeq)
  // from src/mirror/dedup.ts instead of reading from the legacy JSON
  // checkpoint. Falls back to legacy checkpoint if mirror is empty
  // (pre-migration sessions).
  //
  // Invariant: raw_transcript + dedup_mirror are additive and never
  // lose data. The legacy JSON checkpoint remains as a DR snapshot.
  // ─────────────────────────────────────────────────────────────────────

  const limit = opts.limit ?? 3;
  const skip = opts.skipInjected ?? true;
  const maxTokens = opts.recallMaxTokens ?? 0; // 0 = unbounded (legacy behavior)
  const doWindowDedupe = opts.windowDedupe ?? false;
  const dedupSim = opts.dedupSim ?? 0.9;

  // F4: thread skipInjected through to searchRecall instead of hardcoding false
  // and re-implementing the filter here. newHits is already deduped when skip
  // is true (default); equals hits when skip is false (openclaw command path).
  const { newHits } = searchRecall(
    { sessionId: opts.sessionId, query: opts.query, limit, skipInjected: skip },
    store,
  );

  // F1: hoist one embedder instance for inline dedupe (matches the async path).
  // defaultEmbedder() is deterministic but creating it per hit wastes allocations.
  const embedder = defaultEmbedder();
  // Precompute live-window embeddings once for inline dedupe (Fix C). Trigram
  // embedder is local + cheap; never a network call (PREVENT-PI-004).
  let liveEmbeddings: number[][] = [];
  if (doWindowDedupe && opts.liveWindow && opts.liveWindow.length > 0) {
    liveEmbeddings = opts.liveWindow.map((m) => embedder.embed(m));
  }

  // F3: build the hit list first; format ONCE at the end so the block carries
  // exactly one preamble and [1..n] numbering, and the token cap counts body
  // tokens (one preamble at format time, not N). We accumulate summaries and
  // break mid-stream when the cap would be exceeded.
  const toInject: SearchHit[] = [];
  let blockTokens = 0;

  for (const h of newHits) {
    // Inline dedupe: skip a hit already resident in the live window (Fix C).
    if (doWindowDedupe && liveEmbeddings.length > 0) {
      const hitVec = embedder.embed(h.checkpoint.summary);
      if (liveEmbeddings.some((v) => cosineSimilarity(v, hitVec) >= dedupSim)) continue;
    }

    const partTokens = estimateBlockTokens(h.checkpoint.summary);
    // Token cap: never push a chunk that would overrun the ceiling.
    if (maxTokens > 0 && blockTokens + partTokens > maxTokens) break;

    toInject.push(h);
    blockTokens += partTokens;
    vectorMarkInjected(store, opts.sessionId, h.checkpoint.checkpointId);
  }

  // F3: format once — one preamble, correct [1..n] numbering.
  const recallBlock = toInject.length > 0 ? formatRecallBlock(toInject) : "";
  const report = toInject.map(
    (h) => `  • ${h.checkpoint.checkpointId} (${h.checkpoint.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
  );

  // S25 Phase-2 (RAPTOR_INJECT_SUMMARIES): prepend a hierarchical overview
  // header built from the tree's top-level summary nodes (root + the
  // highest-scoring level-1 cluster summaries). This gives the model a topical
  // map of the session before the detailed checkpoint hits. Default ON via
  // the store's config; `opts.raptorSummaries` (when explicitly set) overrides.
  // Skipped when no tree exists, the tree is stale/timedOut, or shadow mode is on.
  let overview = "";
  const injectSummaries = opts.raptorSummaries ?? store.cfg.RAPTOR_INJECT_SUMMARIES;
  if (injectSummaries && recallBlock) {
    overview = raptorOverviewBlock(store, opts.sessionId, opts.query);
  }
  const block = overview && recallBlock
    ? overview + "\n" + recallBlock
    : overview || recallBlock;

  return {
    toInject,
    report,
    block,
    empty: block.length === 0,
  };
}

/**
 * S25 Phase-2: build the hierarchical overview header for a session. Rehydrates
 * the persisted RAPTOR tree, picks the root + top level-1 cluster nodes by
 * cosine similarity to the query, and formats them via formatRaptorBlock.
 * Returns "" when no tree, stale tree, timedOut tree, or shadow mode. Non-fatal
 * (wrapped in try/catch) — the overview is a bonus; a failure must never block
 * the detailed recall block.
 */
function raptorOverviewBlock(
  store: VectorStore,
  sessionId: string,
  query: string,
): string {
  try {
    const sid = normalizeSessionId(sessionId);
    const tree = rehydrateRaptorTree(sid, store.stateDir);
    if (!tree || !tree.rootId || tree.timedOut) return "";
    const root = tree.nodes.get(tree.rootId);
    if (!root) return "";
    const qv = store.embedder.embed(query);
    // Root (level 0) first, then the top level-1 clusters by cosine to the query.
    const nodes: { summary: string; level: number; score: number }[] = [
      { summary: root.summary, level: root.level, score: cosineSimilarity(qv, root.embedding) },
    ];
    const level1 = [...tree.nodes.values()]
      .filter((n) => n.level === 1 && n.summary)
      .map((n) => ({ summary: n.summary, level: n.level, score: cosineSimilarity(qv, n.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    nodes.push(...level1);
    return formatRaptorBlock(nodes);
  } catch {
    return ""; // non-fatal: overview is a bonus
  }
}

// --- S21: memory recall ----------------------------------------------------
// Durables (decisions, rules, user-saved facts) live in the `memories` table.
// We mirror the checkpoint recall path: rank by cosine, format a block, respect
// a token cap so it can never net-inflate the system prompt.

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

/** Format one memory hit for the recall block. Category + score for traceability. */
export function formatMemoryRecallBlock(
  hits: Array<{ content: string; category: string | null; score: number }>,
): string {
  if (hits.length === 0) return "";
  const parts = hits.map((h, i) => {
    const pct = (h.score * 100).toFixed(0);
    const cat = h.category ? `[${h.category}] ` : "";
    return `### Recalled memory [${i + 1}] (relevance ${pct}%)\n${cat}${h.content.trim()}`;
  });
  return (
    "The following facts about this project were saved from earlier turns " +
    "and are relevant to the current request. Treat them as established:\n\n" +
    parts.join("\n")
  );
}

/** Recall top-k durable memories, format into a token-capped block. */
export async function recallMemoriesAndInline(
  opts: MemoryRecallInjectOptions,
): Promise<{ empty: boolean; block: string; report: string[] }> {
  const limit = opts.limit ?? 5;
  const maxTokens = opts.recallMaxTokens ?? 0;
  const { recallMemories, recallMemoriesCrossRepo } = await import("./memoryRecall.js");
  const hits = await recallMemories(opts.query, opts.stateDir, {
    topK: limit,
    minSimilarity: opts.minSimilarity ?? 0.2,
  });

  // S24 cross-repo augmentation: if same-repo recall is thin, pull additional
  // memories from OTHER repos via the PGlite HNSW index. Non-fatal: a failure
  // degrades to the same-repo hits only.
  const crossHits: Array<{ memory: any; score: number; repoId: string }> = [];
  if (opts.crossRepo && hits.length < limit) {
    try {
      const x = await recallMemoriesCrossRepo(opts.query, opts.stateDir, {
        repo: null,
        limit: limit - hits.length,
        crossRepoCosine: opts.crossRepoCosine ?? 0.3,
      });
      for (const h of x) crossHits.push(h);
    } catch {
      /* non-fatal — cross-repo failure → same-repo only */
    }
  }
  if (hits.length === 0 && crossHits.length === 0) return { empty: true, block: "", report: [] };

  // Same incremental token cap pattern as checkpoint recall.
  const parts: string[] = [];
  const report: string[] = [];
  let blockTokens = 0;
  const pushHit = (content: string, category: string | null, score: number, label: string) => {
    const part = formatMemoryRecallBlock([{ content, category, score }]);
    const partTokens = estimateBlockTokens(part);
    if (maxTokens > 0 && blockTokens + partTokens > maxTokens) return false;
    parts.push(part);
    report.push(`  • ${label} (${(score * 100).toFixed(0)}%): ${content.slice(0, 60).replace(/\n/g, " ")}…`);
    blockTokens += partTokens;
    return true;
  };
  for (const h of hits) {
    if (!pushHit(h.memory.content, h.memory.category, h.score, `memory#${h.memory.id}`)) break;
  }
  for (const h of crossHits) {
    const repoLabel = h.repoId.split(/[\\/]/).filter(Boolean).pop() ?? h.repoId;
    if (!pushHit(h.memory.content, h.memory.category, h.score, `memory#${h.memory.id} (from ${repoLabel})`)) break;
  }
  return { empty: parts.length === 0, block: parts.join("\n"), report };
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
  store: VectorStore,
): Promise<RecallInjectResult> {
  const limit = opts.limit ?? 3;
  const skip = opts.skipInjected ?? true;
  const maxTokens = opts.recallMaxTokens ?? 0;
  const doWindowDedupe = opts.windowDedupe ?? false;
  const dedupSim = opts.dedupSim ?? 0.9;

  let hits: SearchHit[] = [];
  try {
    hits = await vectorSearchAsync(store, opts.sessionId, opts.query, limit, {
      crossRepo: opts.crossRepo,
      repoId: opts.repoId,
    });
  } catch {
    hits = [];
  }

  // F1: hoist one embedder instance for inline dedupe. defaultEmbedder() is
  // deterministic but creating it per call wastes allocations on large hit sets.
  // (recallAndInline already hoisted this; applying the same fix here.)
  const embedder = defaultEmbedder();
  let liveEmbeddings: number[][] = [];
  if (doWindowDedupe && opts.liveWindow && opts.liveWindow.length > 0) {
    liveEmbeddings = opts.liveWindow.map((m) => embedder.embed(m));
  }

  const toInject: SearchHit[] = [];
  let blockTokens = 0;

  // F2: when cross-repo is on but no global index dir could be resolved, skip
  // foreign hits rather than injecting them undeduped — otherwise a foreign
  // checkpoint with no machine-wide injected-set to consult would re-inject in
  // every new session. Same-repo hits (no repoId) are unaffected. Warn once so
  // the silent degradation is observable. (The extension resolver normally
  // supplies a default globalIndexDir, so this is belt-and-braces.)
  const skipCrossRepoHits = !!opts.crossRepo && !opts.globalIndexDir;
  if (skipCrossRepoHits) {
    try {
      console.warn(
        "[mega-compact:recall] cross-repo recall enabled but globalIndexDir is unset — "
          + "skipping cross-repo injection to avoid re-injecting undeduped foreign checkpoints",
      );
    } catch { /* ignore */ }
  }

  for (const h of hits) {
    // F2: skip foreign hits when we can't dedup them machine-wide.
    if (skipCrossRepoHits && h.repoId) continue;
    if (skip && vectorWasInjected(store, opts.sessionId, h.checkpoint.checkpointId)) continue;
    // S18: machine-wide injected-set — a foreign checkpoint already injected
    // (in any session) is never re-injected. Only applies to cross-repo hits
    // (same-repo hits have no repoId and are handled by the per-session set).
    if (opts.globalIndexDir && h.repoId) {
      try {
        const { wasInjectedGlobal } = await import("./store/sqlite.js");
        if (wasInjectedGlobal(h.checkpoint.checkpointId, opts.sessionId, opts.globalIndexDir)) continue;
      } catch {
        /* non-fatal: degrade to per-session injected-set only */
      }
    }
    // Inline dedupe: skip a hit already resident in the live window (F1: hoisted embedder).
    if (doWindowDedupe && liveEmbeddings.length > 0) {
      const hitVec = embedder.embed(h.checkpoint.summary);
      if (liveEmbeddings.some((v) => cosineSimilarity(v, hitVec) >= dedupSim)) continue;
    }
    // F3: build the hit list first; format ONCE at the end so the block carries
    // exactly one preamble and numbering [1..n] rather than one per hit.
    const partTokens = estimateBlockTokens(h.checkpoint.summary);
    if (maxTokens > 0 && blockTokens + partTokens > maxTokens) break;
    toInject.push(h);
    blockTokens += partTokens;
    vectorMarkInjected(store, opts.sessionId, h.checkpoint.checkpointId);
    // S18: record the cross-repo injection machine-wide so it's not re-injected
    // by a later recall (same or different session).
    if (opts.globalIndexDir && h.repoId) {
      try {
        const { markInjectedGlobal } = await import("./store/sqlite.js");
        markInjectedGlobal(h.checkpoint.checkpointId, h.repoId, opts.sessionId, opts.globalIndexDir);
      } catch {
        /* non-fatal */
      }
    }
  }

  // F3: format once — one preamble, correct [1..n] numbering, token cap counted
  // against one preamble (not N). Pass the full toInject array so formatRecallBlock
  // has repoId + score for proper labeling.
  const block = toInject.length > 0 ? formatRecallBlock(toInject) : "";
  const report = toInject.map(
    (h) => `  • ${h.checkpoint.checkpointId} (${h.checkpoint.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
  );

  return { toInject, report, block, empty: toInject.length === 0 };
}
