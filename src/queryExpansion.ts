/**
 * queryExpansion.ts — S45 CRAG query expansion via embedding neighbors.
 *
 * Expands a query with synonym/related-term variants by finding embedding-
 * similar checkpoints and extracting their discriminative terms. Fully local:
 * uses the TrigramEmbedder (shipped default, zero network) and in-process
 * cosine scan — no LLM call, no external API. PREVENT-PI-004 compliant.
 *
 * Pi-agnostic: no pi runtime types or imports from `src/`.
 */

import type { Embedder } from "./embedder.js";
import { cosineSimilarity, defaultEmbedder } from "./embedder.js";
import type { VectorStore } from "./vectorStore.js";
import { listCheckpoints } from "./store/sqlite.js";

/**
 * Options for query expansion.
 */
export interface QueryExpansionOptions {
  /** Maximum number of expansion terms to return. Default 5. */
  maxTerms?: number;
  /** Minimum cosine similarity for a checkpoint to be considered. Default 0.3. */
  minSimilarity?: number;
  /** Embedder override (defaults to TrigramEmbedder, zero network). */
  embedder?: Embedder;
}

const DEFAULT_MAX_TERMS = 5;
const DEFAULT_MIN_SIM = 0.3;

/**
 * Tokenize text into lowercased alphanumeric terms, filtering stop words.
 * Internal helper — no export needed outside this module.
 */
function tokenizeTerms(text: string): string[] {
  const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
    "been", "has", "have", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "not", "no", "nor",
    "so", "if", "then", "than", "that", "this", "these", "those", "it",
    "its", "i", "me", "my", "we", "our", "you", "your", "he", "she",
    "they", "them", "their", "what", "which", "who", "whom", "when",
    "where", "why", "how", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "only", "own", "same", "so", "than",
    "too", "very", "just", "about", "above", "after", "again", "against",
    "because", "before", "between", "down", "during", "out", "over",
    "through", "under", "up", "also", "into", "off", "onto", "upon",
  ]);

  // Split on non-alphanumeric, lowercase, filter empties and stop words.
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Compute TF-IDF-like term importance scores for a set of documents.
 * Returns a Map from term to score (log-frequency within doc * IDF).
 */
function termScores(
  docs: string[],
): Map<string, number> {
  const docCount = docs.length;
  if (docCount === 0) return new Map();

  // Document frequency: how many docs each term appears in.
  const df = new Map<string, number>();
  const docTerms = docs.map((d) => {
    const terms = tokenizeTerms(d);
    const unique = new Set(terms);
    for (const t of unique) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    return terms;
  });

  // Compute TF-IDF score for each term across all docs:
  //   score = sum over docs of (tf * idf)
  //   tf    = term frequency within doc (log-smooth)
  //   idf   = log(1 + docCount / (1 + docFreq))
  const scores = new Map<string, number>();
  for (let i = 0; i < docTerms.length; i++) {
    const terms = docTerms[i];
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, count] of tf) {
      const tfVal = 1 + Math.log10(count);
      const docFreq = df.get(t) ?? 1;
      const idf = Math.log10(1 + docCount / (1 + docFreq));
      scores.set(t, (scores.get(t) ?? 0) + tfVal * idf);
    }
  }

  return scores;
}

/**
 * Expand a query with related terms discovered from embedding-neighbor
 * checkpoints. Uses TF-IDF term extraction from the most similar checkpoints
 * to find novel, discriminative terms not already in the query.
 *
 * @param query   The original search query.
 * @param store   VectorStore instance (for checkpoint access + embedder).
 * @returns       Array of expansion terms (lowercased, max `maxTerms`).
 */
export function expandQuery(
  query: string,
  store: VectorStore,
  opts: QueryExpansionOptions = {},
): string[] {
  const maxTerms = opts.maxTerms ?? DEFAULT_MAX_TERMS;
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIM;
  const embedder = opts.embedder ?? store.embedder ?? defaultEmbedder();

  // Embed the query and scan all checkpoints for nearest neighbors.
  const qv = embedder.embed(query);

  // We need a valid session scope. Since VectorStore checkpoint access flows
  // through the SQLite store, list checkpoints from the store's stateDir.
  // We scan all sessions' checkpoints in the local store for broad coverage.
  // Aggregate candidate documents from the top-N similar checkpoints.
  interface Candidate {
    summary: string;
    score: number;
  }
  const candidates: Candidate[] = [];
  const allSessions = collectSessionIds(store.stateDir);
  const seen = new Set<string>();

  for (const sid of allSessions) {
    const cps = listCheckpoints(sid, store.stateDir);
    for (const cp of cps) {
      if (!cp.summary || seen.has(cp.checkpointId)) continue;
      seen.add(cp.checkpointId);
      const sim = cosineSimilarity(qv, cp.embedding);
      if (sim >= minSim) {
        candidates.push({ summary: cp.summary, score: sim });
      }
    }
  }

  if (candidates.length === 0) return [];

  // Sort by similarity descending, take the top 20 for term extraction.
  const topCandidates = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  // Compute TF-IDF scores across the candidate summaries.
  const docTexts = topCandidates.map((c) => c.summary);
  const scores = termScores(docTexts);

  // Filter out query terms: we want NOVEL terms, not the ones already in the query.
  const queryTerms = new Set(tokenizeTerms(query));

  // Sort terms by score descending, filter query terms and short/noise terms.
  const ranked = [...scores.entries()]
    .filter(([term]) => !queryTerms.has(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);

  return ranked;
}

/**
 * Collect unique session IDs that have at least one checkpoint in the store.
 * Scans the SQLite checkpoint table. Returns an empty array on any error
 * (non-fatal — query expansion degrades gracefully).
 */
function collectSessionIds(stateDir: string): string[] {
  try {
    // We import listCheckpoints per session dynamically. A simpler approach:
    // scan via a direct SQL query rather than reading every session.
    // Reuse store/sqlite.ts functions — we can read the sessions table.
    // Fallback: try listing checkpoints for all known session IDs via
    // the sessions table.
    const { db } = loadDb(stateDir);
    const rows = db
      .prepare("SELECT DISTINCT session_id FROM checkpoint_epochs ORDER BY session_id")
      .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  } catch {
    return [];
  }
}

/**
 * Lazy-load the SQLite database handle for a given stateDir.
 * Cached per stateDir to avoid re-opening the file on every call.
 */
const _dbCache = new Map<string, { db: import("node:sqlite").DatabaseSync }>();

function loadDb(stateDir: string): { db: import("node:sqlite").DatabaseSync } {
  const cached = _dbCache.get(stateDir);
  if (cached) return cached;
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { join } = require("node:path") as typeof import("node:path");
  const db = new DatabaseSync(join(stateDir, "mega-compact.db"));
  db.exec("PRAGMA busy_timeout = 5000"); // tolerate concurrent-opener WAL contention (see store/sqlite/utils.ts)
  db.exec("PRAGMA journal_mode=WAL");
  _dbCache.set(stateDir, { db });
  return { db };
}
