/**
 * queryReformulation.ts — fully local, zero-LLM query reformulation for vague
 * recall queries (S43).
 *
 * Shell: delegates TF-IDF extraction to queryReformulation/tfidf.ts and
 * vagueness detection to queryReformulation/vagueness.ts. Orchestrates the
 * pipeline here.
 *
 * Pipeline:
 *   1. Embed the raw query via the project's default TrigramEmbedder.
 *   2. Linear-scan the real `context_chunks` store for top-N cosine neighbors.
 *   3. Extract high-IDF terms from those neighbors (real TF-IDF, no stopword
 *      list — high-frequency terms naturally get low IDF).
 *   4. Expand the query with the top-IDF terms.
 *   5. Re-embed the expanded query and fuse both ranked lists via RRF.
 *
 * Pi-agnostic: no pi runtime types. Pure src/ module.
 */

import { isVagueQuery } from "./queryReformulation/vagueness.js";
import { extractExpansionTerms } from "./queryReformulation/tfidf.js";
import { reciprocalRankFusion } from "./queryReformulation/rrf.js";
import {
  cacheGet,
  cacheSet,
  maybeLogCacheStats,
  computeUncalibrated,
  QUERY_REFORM_CACHE_TTL_SECONDS,
  EXPANSION_NEIGHBOR_COUNT,
  EXPANSION_TOP_TERMS,
  VAGUE_MIN_WORDS,
  VAGUE_VERY_SHORT_WORDS,
  RRF_K,
} from "./queryReformulation/cache.js";
import type { ReformulationConfig } from "./queryReformulation/cache.js";
import type { Vector } from "./embedder.js";

export { isVagueQuery } from "./queryReformulation/vagueness.js";
export { extractExpansionTerms } from "./queryReformulation/tfidf.js";
export { reciprocalRankFusion, type RankedItem } from "./queryReformulation/rrf.js";
export { readCacheStats } from "./queryReformulation/cache.js";
export type { FusedItem } from "./queryReformulation/rrf.js";
export type { ReformulationConfig } from "./queryReformulation/cache.js";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface ReformulationResult {
  /** The expanded query string (equals `original` when no expansion happened). */
  expanded: string;
  /** The original query (always preserved). */
  original: string;
  /** Neighbor chunks that contributed expansion terms (empty when skipped). */
  neighbors: Array<{ id: string; score: number }>;
  /** Top weighted terms from TF-IDF over neighbors (empty when skipped). */
  terms: Array<{ term: string; tfIdf: number; df: number }>;
  /** Whether RRF fusion was applied (false = raw-query-only path). */
  rrfApplied: boolean;
  /** Whether this result came from the in-memory cache. */
  fromCache: boolean;
  /**
   * List of config-constant names that were at their default (uncalibrated)
   * values when this reformulation ran. Never includes RRF_K.
   */
  uncalibrated: string[];
  /** Reasoning label when skipped ("not_vague", "empty_corpus", "thin_corpus"). */
  skipReason?: string;
}

export interface CorpusStats {
  totalDocs: number;
  docFreq: (term: string) => number;
}

export interface EmbedderLike {
  readonly dim: number;
  embed(text: string): Vector;
}

/** Scanner: given an embedding vector, return top-N nearest neighbor ids + scores. */
export type NeighborScanner = (
  embedding: Vector,
  limit: number,
) => Array<{ id: string; score: number }>;

/** Simple search: run a query, return id+score pairs. */
export type SimpleSearch = (
  query: string,
  limit: number,
) => Array<{ id: string; score: number }>;

// ---------------------------------------------------------------------------
// Embedding Neighbor Finder (S43A-5)
// ---------------------------------------------------------------------------

/**
 * Find the top-N nearest neighbor chunks by real cosine similarity over the
 * real `context_chunks` store. Uses the provided embedder + scan function.
 */
export function findExpansionNeighbors(
  query: string,
  embedder: EmbedderLike,
  scan: NeighborScanner,
  neighborCount: number,
): Array<{ id: string; score: number }> {
  const embedding = embedder.embed(query);
  if (embedding.length === 0) return [];
  return scan(embedding, neighborCount);
}

// ---------------------------------------------------------------------------
// Build Expanded Query
// ---------------------------------------------------------------------------

/**
 * Build an expanded query by appending the top IDF-weighted terms from the
 * expansion neighbors to the original query. Simple concatenation: the
 * expanded string is `"originalQuery topTerm1 topTerm2 ..."`.
 */
export function buildExpandedQuery(
  original: string,
  terms: Array<{ term: string }>,
  maxTerms: number = EXPANSION_TOP_TERMS,
): string {
  if (terms.length === 0) return original;
  const extra = terms.slice(0, maxTerms).map((t) => t.term).join(" ");
  return `${original} ${extra}`;
}

// ---------------------------------------------------------------------------
// Public API: reformulateQuery (S43A-9)
// ---------------------------------------------------------------------------

/**
 * Reformulate a query using the fully local pipeline:
 *   1. Check cache (TTL-gated)
 *   2. Check vagueness — skip if not vague
 *   3. Find embedding neighbors
 *   4. Extract TF-IDF terms from neighbor texts
 *   5. Build expanded query
 *   6. Optionally re-embed and search (caller handles RRF fusion)
 *
 * Error contract:
 *   - If the embedder throws OR the scan fails: the error propagates to the
 *     caller (NOT caught here). The caller is responsible for the
 *     `query_reformulation_failed` event + fallback to raw query.
 *   - If the corpus is empty: returns raw query with rrfApplied: false and
 *     skipReason: "empty_corpus".
 *   - If the corpus is too thin (< 2 neighbors): returns raw query with
 *     rrfApplied: false and skipReason: "thin_corpus".
 *   - If the query is not vague: returns raw query with rrfApplied: false and
 *     skipReason: "not_vague".
 */
export function reformulateQuery(
  query: string,
  embedder: EmbedderLike,
  scan: NeighborScanner,
  corpus: CorpusStats,
  neighborTexts: (ids: string[]) => Array<{ id: string; text: string }>,
  opts: Partial<ReformulationConfig> = {},
  log?: { info: (event: string, fields?: Record<string, unknown>) => void; warn: (event: string, fields?: Record<string, unknown>) => void; error: (event: string, fields?: Record<string, unknown>) => void },
): { result: ReformulationResult; rawNeighbors: Array<{ id: string; score: number }>; rawTerms: Array<{ id: string; text: string }> } {
  const config: ReformulationConfig = {
    neighborCount: opts.neighborCount ?? EXPANSION_NEIGHBOR_COUNT,
    topTerms: opts.topTerms ?? EXPANSION_TOP_TERMS,
    vagueMinWords: opts.vagueMinWords ?? VAGUE_MIN_WORDS,
    vagueVeryShortWords: opts.vagueVeryShortWords ?? VAGUE_VERY_SHORT_WORDS,
    cacheTtlSeconds: opts.cacheTtlSeconds ?? QUERY_REFORM_CACHE_TTL_SECONDS,
    rrfK: opts.rrfK ?? RRF_K,
    searchLimit: opts.searchLimit ?? 5,
  };

  const ttlMs = config.cacheTtlSeconds * 1000;

  // 0. Check cache
  const cached = cacheGet(query, ttlMs);
  if (cached) {
    maybeLogCacheStats(log);
    return {
      result: cached,
      rawNeighbors: cached.neighbors,
      rawTerms: cached.neighbors.map((n) => ({ id: n.id, text: "" })),
    };
  }

  // 1. Vagueness check
  if (!isVagueQuery(query, { vagueMinWords: config.vagueMinWords, vagueVeryShortWords: config.vagueVeryShortWords })) {
    const result: ReformulationResult = {
      expanded: query,
      original: query,
      neighbors: [],
      terms: [],
      rrfApplied: false,
      fromCache: false,
      uncalibrated: computeUncalibrated(config),
      skipReason: "not_vague",
    };
    cacheSet(query, result);
    maybeLogCacheStats(log);
    log?.info("query_reformulation_skipped", { query: query.slice(0, 80), reason: "not_vague" });
    return { result, rawNeighbors: [], rawTerms: [] };
  }

  // 2. Corpus check
  if (corpus.totalDocs <= 0) {
    const result: ReformulationResult = {
      expanded: query,
      original: query,
      neighbors: [],
      terms: [],
      rrfApplied: false,
      fromCache: false,
      uncalibrated: computeUncalibrated(config),
      skipReason: "empty_corpus",
    };
    cacheSet(query, result);
    maybeLogCacheStats(log);
    log?.info("query_reformulation_skipped", { query: query.slice(0, 80), reason: "empty_corpus" });
    return { result, rawNeighbors: [], rawTerms: [] };
  }

  // 3. Find embedding neighbors
  const neighbors = findExpansionNeighbors(query, embedder, scan, config.neighborCount);
  if (neighbors.length < 2) {
    const result: ReformulationResult = {
      expanded: query,
      original: query,
      neighbors,
      terms: [],
      rrfApplied: false,
      fromCache: false,
      uncalibrated: computeUncalibrated(config),
      skipReason: "thin_corpus",
    };
    cacheSet(query, result);
    maybeLogCacheStats(log);
    log?.info("query_reformulation_skipped", { query: query.slice(0, 80), reason: "thin_corpus" });
    return { result, rawNeighbors: neighbors, rawTerms: [] };
  }

  // 4. Fetch neighbor texts for TF-IDF
  const neighborIds = neighbors.map((n) => n.id);
  const rawTerms = neighborTexts(neighborIds);

  // 5. Extract expansion terms via TF-IDF
  const expansionTerms = extractExpansionTerms(rawTerms, corpus, config.topTerms);
  if (expansionTerms.length === 0) {
    const result: ReformulationResult = {
      expanded: query,
      original: query,
      neighbors,
      terms: [],
      rrfApplied: false,
      fromCache: false,
      uncalibrated: computeUncalibrated(config),
      skipReason: "thin_corpus",
    };
    cacheSet(query, result);
    maybeLogCacheStats(log);
    log?.info("query_reformulation_skipped", { query: query.slice(0, 80), reason: "thin_corpus" });
    return { result, rawNeighbors: neighbors, rawTerms };
  }

  // 6. Build expanded query
  const expanded = buildExpandedQuery(query, expansionTerms, config.topTerms);
  const uncalibrated = computeUncalibrated(config);

  const result: ReformulationResult = {
    expanded,
    original: query,
    neighbors: neighbors.map((n) => ({ id: n.id, score: n.score })),
    terms: expansionTerms,
    rrfApplied: true,
    fromCache: false,
    uncalibrated,
  };

  cacheSet(query, result);
  maybeLogCacheStats(log);

  log?.info("query_reformulation", {
    query: query.slice(0, 80),
    expanded: expanded.slice(0, 120),
    neighborCount: neighbors.length,
    topTerms: expansionTerms.slice(0, 5).map((t) => t.term),
    rrfApplied: true,
    fromCache: false,
    uncalibrated,
  });

  return { result, rawNeighbors: neighbors, rawTerms };
}

// ---------------------------------------------------------------------------
// Public API: reformulationSearch (S43A-9b)
// ---------------------------------------------------------------------------

export interface ReformulationSearchResult {
  /** Fused search results (RRF-merged or raw-query-only). */
  fused: Array<{ id: string; score: number }>;
  /** Reformulation metadata. */
  reformulation: ReformulationResult;
  /** Raw-query-only search results (for the S41 quality gate). */
  rawSearchResults: Array<{ id: string; score: number }>;
}

/**
 * Full reformulation search pipeline:
 *   1. Reformulate the query (embedding neighbors -> TF-IDF -> expansion).
 *   2. If RRF was applied: run BOTH raw + expanded queries and fuse via RRF.
 *   3. If no RRF: return raw-query results only.
 */
export function reformulationSearch(
  query: string,
  embedder: EmbedderLike,
  scan: NeighborScanner,
  corpus: CorpusStats,
  neighborTexts: (ids: string[]) => Array<{ id: string; text: string }>,
  search: SimpleSearch,
  opts: Partial<ReformulationConfig> = {},
  log?: { info: (event: string, fields?: Record<string, unknown>) => void; warn: (event: string, fields?: Record<string, unknown>) => void; error: (event: string, fields?: Record<string, unknown>) => void },
): ReformulationSearchResult {
  const config: ReformulationConfig = {
    neighborCount: opts.neighborCount ?? EXPANSION_NEIGHBOR_COUNT,
    topTerms: opts.topTerms ?? EXPANSION_TOP_TERMS,
    vagueMinWords: opts.vagueMinWords ?? VAGUE_MIN_WORDS,
    vagueVeryShortWords: opts.vagueVeryShortWords ?? VAGUE_VERY_SHORT_WORDS,
    cacheTtlSeconds: opts.cacheTtlSeconds ?? QUERY_REFORM_CACHE_TTL_SECONDS,
    rrfK: opts.rrfK ?? RRF_K,
    searchLimit: opts.searchLimit ?? 5,
  };

  const { result: reformulation } = reformulateQuery(
    query, embedder, scan, corpus, neighborTexts, opts, log,
  );

  // Always run the raw query search (needed for the S41 quality gate and as
  // a fallback when RRF is not applied).
  const rawSearchResults = search(query, config.searchLimit);

  if (!reformulation.rrfApplied) {
    return { fused: rawSearchResults, reformulation, rawSearchResults };
  }

  // RRF path: run expanded query search and fuse
  const expandedResults = search(reformulation.expanded, config.searchLimit);

  const rawRanked = rawSearchResults.map((r, i) => ({ id: r.id, rank: i + 1 }));
  const expandedRanked = expandedResults.map((r, i) => ({ id: r.id, rank: i + 1 }));

  const fused = reciprocalRankFusion([rawRanked, expandedRanked], config.rrfK);

  return { fused, reformulation, rawSearchResults };
}
