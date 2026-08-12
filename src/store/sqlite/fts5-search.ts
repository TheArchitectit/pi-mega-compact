/**
 * fts5-search.ts — FTS5 trigram search helper (L1 tier in the S44 tiered router).
 *
 * Runs BM25-ranked trigram search against the existing `context_chunks_trgm`
 * virtual table (pg_trgm-equivalent, created in schema.ts). All queries are
 * parameterized (PREVENT-002). Pi-agnostic — pure SQL over a node:sqlite
 * DatabaseSync handle.
 *
 * The virtual table stores (id UNINDEXED, normalized_text) with tokenize='trigram'.
 * FTS5 trigram queries tokenize the user query into overlapping 3-grams at query
 * time automatically — no manual n-gram splitting needed. The BM25 rank from
 * fts5 ranks results by trigram-overlap density.
 */

import type { DatabaseSync } from "node:sqlite";
import { listCheckpoints } from "./checkpoints.js";

export interface Fts5Hit {
	/** checkpoint id (chkpt_001 etc.) from the context_chunks_trgm row. */
	id: string;
	/** BM25 relevance score from FTS5 (higher = better match). */
	score: number;
}

/**
 * Search the context_chunks_trgm FTS5 table for checkpoints whose
 * `normalized_text` matches `query` via trigram similarity.
 *
 * @param query  Raw search text (FTS5 trigram tokenizer handles n-gram splitting
 *               automatically; input is NOT SQL-concatenated — bound as ? param).
 * @param reader A sync-reader handle against the SQLite store.
 * @param limit  Max results to return (default 10).
 * @returns BM25-ranked hits, highest score first.
 */
export function fts5Search(
	query: string,
	reader: DatabaseSync,
	limit = 10,
): Fts5Hit[] {
	const sql = `
    SELECT id, bm25(context_chunks_trgm, 0.0, 1.0) AS score
    FROM context_chunks_trgm
    WHERE context_chunks_trgm MATCH ?
    ORDER BY score
    LIMIT ?
  `;
	const rows = reader
		.prepare(sql)
		.all(query, limit) as Array<{ id: string; score: number }>;

	return rows.map((r) => ({ id: r.id, score: r.score }));
}

/**
 * Search with an optional session_id filter for scoped FTS5 recall.
 *
 * JOINs the FTS5 virtual table against the real `context_chunks` table on `id`
 * so we can filter by `session_id` while still using FTS5 MATCH. The vtab
 * stores `id UNINDEXED` (it's a row-key passthrough, not searchable text), so
 * the join is safe and efficient via the `idx_chunks_pk` index.
 *
 * @param query     Raw search text.
 * @param reader    Sync-reader handle against the SQLite store.
 * @param sessionId Scope to a specific session (omit for cross-session search).
 * @param limit     Max results (default 10).
 */
export function fts5SearchScoped(
	query: string,
	reader: DatabaseSync,
	sessionId: string | undefined,
	limit = 10,
): Fts5Hit[] {
	if (sessionId) {
		const sql = `
      SELECT t.id, bm25(context_chunks_trgm, 0.0, 1.0) AS score
      FROM context_chunks_trgm AS t
      INNER JOIN context_chunks AS c ON c.id = t.id
      WHERE t.context_chunks_trgm MATCH ?
        AND c.session_id = ?
      ORDER BY score
      LIMIT ?
    `;
		const rows = reader
			.prepare(sql)
			.all(query, sessionId, limit) as Array<{ id: string; score: number }>;
		return rows.map((r) => ({ id: r.id, score: r.score }));
	}

	// No session filter — plain FTS5 search across all sessions.
	return fts5Search(query, reader, limit);
}

/** A hydrated FTS5 hit: the id + BM25 score joined with its checkpoint summary. */
export interface HydratedFts5Hit {
	/** checkpoint id the FTS5 row referred to. */
	checkpointId: string;
	/** BM25 relevance score carried over from the FTS5 row. */
	score: number;
	/** The joined checkpoint's summary text (content basis for L0 digest dedup). */
	summary: string;
}

/**
 * Hydrate FTS5 hits (which only carry checkpoint `id` + BM25 `score`, with NO
 * checkpoint object) by joining against the real stored checkpoints. Mirrors the
 * private `hydrateHits` in tieredRouter.ts (listCheckpoints → Map on
 * checkpointId → join, dropping ids with no checkpoint).
 *
 * The joined `summary` is returned alongside the id because the 3WF-3 voter
 * dedups candidates on the L0 CONTENT digest — hashing the id string instead
 * would be a no-op tier (ids are already unique), silently disabling the check.
 *
 * @param hits      Raw Fts5Hit rows (id + BM25 score).
 * @param sessionId Session scope used to fetch the checkpoint set.
 * @param stateDir  On-disk state dir for the sync store.
 */
export function hydrateFts5Hits(
	hits: Fts5Hit[],
	sessionId: string,
	stateDir: string,
): HydratedFts5Hit[] {
	const cps = listCheckpoints(sessionId, stateDir);
	const cpMap = new Map(cps.map((cp) => [cp.checkpointId, cp]));
	const out: HydratedFts5Hit[] = [];
	for (const h of hits) {
		const cp = cpMap.get(h.id);
		if (cp) out.push({ checkpointId: h.id, score: h.score, summary: cp.summary });
	}
	return out;
}
