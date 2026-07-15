/**
 * index.ts — RAPTOR orchestrator (Sprint 13, Phase 6).
 *
 * Entry point that turns a session's leaves into a hierarchical summary tree.
 * Shadow mode (RAPTOR_SHADOW_MODE default true): the tree is BUILT and PERSISTED
 * to raptor_nodes + logged, but is NOT used to serve retrieval. The live
 * vectorStore.search path is untouched until Sprint 14 promotes RAPTOR.
 *
 * PREVENT-PI-004: no network here. Any Ollama call lives in summarizer.ts
 * (localhost-only, annotated). This module is pure orchestration.
 */

import type { Embedder } from "../../embedder.js";
import { defaultEmbedder } from "../../embedder.js";
import { buildRaptorTree, type Leaf, type RaptorTree } from "./tree.js";
import { stagedExpansion } from "./retrieval.js";
import { Logger } from "../../log.js";
import { saveRaptorTree, listRaptorNodes } from "../../store/sqlite.js";

/** Shadow mode is on by default; set RAPTOR_SHADOW_MODE=false to serve live. */
export function isShadowMode(): boolean {
  return process.env.RAPTOR_SHADOW_MODE !== "false";
}

export interface RaptorOrchestratorOptions {
  embedder?: Embedder;
  stateDir: string;
  sessionId: string;
  budgetMs?: number;
  clustersPerLevel?: number;
  consistencyThreshold?: number;
  /** Best-effort logger for shadow events. */
  logger?: Logger;
}

/**
 * Build the RAPTOR tree for a session's leaves. Per shadow-mode rules, the tree
 * is persisted + logged regardless; whether it is served is the caller's choice
 * (Sprint 13: it is built but NOT injected into recallAndInline).
 *
 * Returns the built tree (in-memory) for eval/tests, and persists it to the
 * store. Never throws — on any build error it logs and returns null.
 */
export function runRaptor(
  leaves: Leaf[],
  opts: RaptorOrchestratorOptions,
): RaptorTree | null {
  const embedder = opts.embedder ?? defaultEmbedder();
  const logger = opts.logger;
  try {
    const tree = buildRaptorTree(leaves, {
      embedder,
      budgetMs: opts.budgetMs,
      clustersPerLevel: opts.clustersPerLevel,
      consistencyThreshold: opts.consistencyThreshold,
    });
    saveRaptorTree(opts.sessionId, tree, opts.stateDir);
    logger?.info("raptor_build", {
      sessionId: opts.sessionId,
      nodes: tree.nodes.size,
      levels: tree.levels,
      rootId: tree.rootId,
      timedOut: tree.timedOut,
      shadow: isShadowMode(),
    });
    if (isShadowMode()) {
      // Build + log only. Do NOT replace retrieval.
      logger?.info("raptor_shadow", { sessionId: opts.sessionId, served: false });
    }
    return tree;
  } catch (e) {
    logger?.error("raptor_build_failed", {
      sessionId: opts.sessionId,
      error: String(e instanceof Error ? e.message : e),
    });
    return null;
  }
}

/**
 * Staged retrieval over a persisted/session tree. Only meaningful when RAPTOR
 * is promoted (Sprint 14); provided here so eval can measure it in shadow.
 *
 * Returns the leaf ids the staged expansion would serve for `query`.
 */
export function recallRaptor(
  query: string,
  sessionId: string,
  opts: { embedder?: Embedder; stateDir: string; k?: number; topM?: number },
): string[] {
  const embedder = opts.embedder ?? defaultEmbedder();
  const tree = rehydrateRaptorTree(sessionId, opts.stateDir);
  if (!tree) return [];
  return stagedExpansion(query, tree, { embedder, k: opts.k, topM: opts.topM });
}

/**
 * Rehydrate a persisted RAPTOR tree from raptor_nodes (Fix D): rebuild the
 * in-memory RaptorTree + parent links so vectorStore.search can serve it live.
 * Returns null when no tree exists (caller falls back to the flat path).
 */
export function rehydrateRaptorTree(
  sessionId: string,
  stateDir: string,
): RaptorTree | null {
  const nodes = listRaptorNodes(sessionId, stateDir);
  if (nodes.length === 0) return null;
  const tree: RaptorTree = {
    nodes: new Map(
      nodes.map((n) => [
        n.id,
        {
          id: n.id,
          level: n.level,
          parentId: n.parentId,
          children: n.children,
          summary: n.summary,
          embedding: n.embedding,
          qualityMarker: n.qualityMarker as any,
          tokenEstimate: n.tokenEstimate,
        },
      ]),
    ),
    rootId:
      nodes.reduce<typeof nodes[number] | null>(
        (best, n) => (!best || n.level > (best?.level ?? -1) ? n : best),
        null,
      )?.id ?? null,
    levels: Math.max(1, ...nodes.map((n) => n.level + 1)),
    timedOut: false,
  };
  return tree;
}

/**
 * Return the RAPTOR root summary for a session, if a tree has been built.
 * Used by the durable-trim driver (Fix B/D) to supply pi a session-level
 * compressed summary instead of one slice's extractive summary. Returns
 * undefined when no tree exists yet (caller falls back to the slice summary).
 */
export function recallRaptorRootSummary(
  sessionId: string,
  stateDir: string,
): string | undefined {
  const nodes = listRaptorNodes(sessionId, stateDir);
  if (nodes.length === 0) return undefined;
  // Highest-level node = the root (covers all leaves).
  const root = nodes.reduce<(typeof nodes)[number] | null>(
    (best, n) => (!best || n.level > best.level ? n : best),
    null,
  );
  return root?.summary || undefined;
}
