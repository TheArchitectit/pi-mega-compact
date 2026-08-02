/**
 * recall/reformulate.ts — S57 RAG suite helpers (B1/B2).
 *
 * Each helper is only called when its feature flag (RAG_QUERY_REFORMULATION /
 * RAG_TIERED_ROUTER) is ON; flag-OFF never reaches them. All degrade
 * non-fatally to the standard path on any error.
 */
import { recall as searchRecall } from "../engine.js";
import type { SearchHit, VectorStore } from "../vectorStore.js";
import { defaultEmbedder } from "../embedder.js";
import { reformulateQuery, isVagueQuery } from "../queryReformulation.js";
import type { CorpusStats, EmbedderLike, NeighborScanner } from "../queryReformulation.js";
import { VAGUE_MIN_WORDS, VAGUE_VERY_SHORT_WORDS } from "../queryReformulation/cache.js";
import { getTieredRouter } from "../tieredRouter.js";

/**
 * B1: If the query is vague, reformulate it via embedding-neighbor TF-IDF
 * expansion. Returns the original query when reformulation is not supported
 * or the query is already specific. Non-fatal: any error → original query.
 */
export function reformulateRecallQuery(
	query: string,
	store: VectorStore,
	sessionId: string,
): string {
	try {
		if (
			!isVagueQuery(query, {
				vagueMinWords: VAGUE_MIN_WORDS,
				vagueVeryShortWords: VAGUE_VERY_SHORT_WORDS,
			})
		)
			return query;
		// Pre-compute neighbor candidates once. reformulateQuery embeds the query
		// and calls `scan` internally; we return these pre-computed neighbors (same
		// query) so the store needs no by-embedding lookup.
		const { hits } = searchRecall(
			{ sessionId, query, limit: 10, skipInjected: false },
			store,
		);
		if (hits.length < 2) return query; // too few neighbors for TF-IDF
		const neighbors = hits.map((h) => ({
			id: h.checkpoint.checkpointId,
			score: h.score,
		}));
		const textById = new Map<string, string>();
		for (const h of hits) textById.set(h.checkpoint.checkpointId, h.checkpoint.summary);
		const scan: NeighborScanner = () => neighbors;
		const corpus: CorpusStats = {
			totalDocs: neighbors.length,
			docFreq: (term: string) => {
				let df = 0;
				for (const text of textById.values()) {
					if (text.toLowerCase().includes(term.toLowerCase())) df++;
				}
				return Math.max(df, 1);
			},
		};
		const neighborTexts = (ids: string[]) =>
			ids.map((id) => ({ id, text: textById.get(id) ?? "" }));
		const { result } = reformulateQuery(
			query,
			defaultEmbedder() as unknown as EmbedderLike,
			scan,
			corpus,
			neighborTexts,
		);
		return result.expanded.length > query.length ? result.expanded : query;
	} catch {
		return query; // non-fatal: fall back to original query
	}
}

/**
 * B2: Synchronous tiered recall. The TieredRouter.route() is async, so the
 * sync path can only peek the L0 in-memory cache; on miss it falls through to
 * the standard sync vector scan. The router's L1/L2 value is realized on the
 * async path (recallAndInlineAsync). Non-fatal.
 */
export function runTieredRecall(
	query: string,
	sessionId: string,
	limit: number,
	skip: boolean,
	store: VectorStore,
): { newHits: SearchHit[]; tier: string } {
	try {
		const router = getTieredRouter();
		if (!router) {
			const result = searchRecall(
				{ sessionId, query, limit, skipInjected: skip },
				store,
			);
			return { newHits: result.newHits, tier: "off" };
		}
		// Peek the L0 in-memory cache synchronously; fall through on miss.
		const cached = router.peekCache(sessionId, query, limit);
		if (cached && cached.length > 0) return { newHits: cached, tier: "L0-cache" };
		const result = searchRecall(
			{ sessionId, query, limit, skipInjected: skip },
			store,
		);
		return { newHits: result.newHits, tier: "sync-fallback" };
	} catch {
		const result = searchRecall(
			{ sessionId, query, limit, skipInjected: skip },
			store,
		);
		return { newHits: result.newHits, tier: "fallback-error" };
	}
}
