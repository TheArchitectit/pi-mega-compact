/**
 * recall/vote.ts — the 3-independent-source recall vote (3WF-3).
 *
 * Three INDEPENDENT, read-only sources name candidate checkpoints:
 *   A vector  — raw semantic hits (recall/readonly.ts), cosine 0..1 scale.
 *   B fts5    — BM25 trigram hits (hydrated to checkpointIds), FTS5 BM25 scale
 *               (negative score = better match; ranking order is what matters).
 *   C recency — the N freshest checkpoints by timestamp, query-INDEPENDENT.
 *               (NOT turn_recall / TurnReader — that would just echo already-
 *               injected content, not an independent signal.)
 *
 * Each source is a different score scale, so they are NOT directly comparable.
 * We normalize each source's scores to a 0..1 scale (per-source min-max) BEFORE
 * combining. Averaging raw cosine (0..1) with raw BM25 (arbitrary negative
 * magnitude) or a recency rank would be meaningless — the largest-magnitude
 * scale would always dominate. Normalization makes each source a peer voter.
 *
 * Overlap rule: a checkpoint named by >=2 of 3 distinct sources short-circuits
 * as a winner. Fallback (no 2/3 majority): rank all candidates by the
 * cross-source MEAN of their normalized scores.
 *
 * Non-fatal throughout. Pi-agnostic: no pi runtime imports.
 */
import { openStore } from "../store/sqlite/utils.js";
import { fts5SearchScoped, hydrateFts5Hits } from "../store/sqlite/fts5-search.js";
// The SQLite store is the source of truth (src/store.ts's same-named helper
// reads the LEGACY gzipped-JSON DR snapshot, which is empty for live sessions —
// importing it here would silently starve sources B and C). Mirrors the import
// in vector-search.ts + tieredRouter.ts.
import { listCheckpoints } from "../store/sqlite.js";
import { computeContentDigest } from "../dedup/digest.js";
import { recallRawHits } from "./readonly.js";
import { Logger } from "../log.js";
import type { VectorStore, SearchHit } from "../vectorStore.js";
import type { RecallCandidate, VoteResult } from "../failback/types.js";

/** Options for the three-source recall vote. */
export interface VoteOptions {
	/** Normalized session id. */
	sessionId: string;
	/** Recall query text. */
	query: string;
	/** Max vector/fts5 hits to consider (default 3). */
	limit?: number;
	/** How many freshest checkpoints source C contributes (default = limit). */
	recencyCount?: number;
}

/**
 * Per-source normalization: map raw scores to 0..1 via min-max within source.
 *
 * E1 follow-up (PR #18 review): non-finite scores (NaN/±Infinity) are DROPPED
 * before the min/max fold — a single NaN silently propagates through Math.min/
 * max and turns EVERY normalized score of that source into NaN (verified),
 * poisoning the whole 3-source quorum. Dropping the bad entry degrades that
 * source gracefully instead. Exported so the guard is unit-testable directly.
 */
export function normalizeScores(scores: number[]): Map<number, number> {
	const map = new Map<number, number>();
	const finite: { idx: number; s: number }[] = [];
	scores.forEach((s, i) => {
		if (Number.isFinite(s)) finite.push({ idx: i, s });
	});
	if (finite.length === 0) return map;
	let min = Infinity;
	let max = -Infinity;
	for (const { s } of finite) {
		if (s < min) min = s;
		if (s > max) max = s;
	}
	const span = max - min;
	for (const { idx, s } of finite) {
		map.set(idx, span === 0 ? 1 : (s - min) / span);
	}
	return map;
}

/**
 * Run the three-source recall vote. Returns agreement winners + a per-id vote
 * count + the names of sources that produced no winning candidate. Non-fatal:
 * any search failure degrades to the remaining sources (empty winners allowed).
 */
export function voteRecall(opts: VoteOptions, store: VectorStore): VoteResult {
	const logger = new Logger();
	const limit = opts.limit ?? 3;
	const recencyCount = opts.recencyCount ?? limit;

	// ── Source A: vector (raw hits, cosine 0..1). ────────────────────────────
	const vectorCands: RecallCandidate[] = recallRawHits(
		{ sessionId: opts.sessionId, query: opts.query, limit },
		store,
	).map((h: SearchHit) => ({
		checkpointId: h.checkpoint.checkpointId,
		score: h.score,
		source: "vector" as const,
	}));

	// ── Source B: fts5 (BM25, hydrated to checkpointIds). ─────────────────────
	// Dedup on L0 content digest so the SAME normalized text under two ids does
	// not double-vote — collapse to one candidate per digest.
	const fts5Cands: RecallCandidate[] = (() => {
		try {
			const reader = openStore(store.stateDir);
			const hits = fts5SearchScoped(opts.query, reader, opts.sessionId, limit);
			// FTS5 returns scores ordered best-first (bm25 asc); lower = better.
			// We keep the raw score (negative-is-better) and flip in normalization.
			const hydrated = hydrateFts5Hits(hits, opts.sessionId, store.stateDir);
			// Dedup on checkpointId so the same checkpoint cannot double-count, AND
			// on the L0 CONTENT digest so identical normalized text stored under two
			// different ids collapses to one vote. The digest is taken over the
			// joined `summary` (real content): hashing the id string would be a
			// no-op tier, since ids are unique by definition.
			const seenDigest = new Set<string>();
			const seenId = new Set<string>();
			const out: RecallCandidate[] = [];
			for (const h of hydrated) {
				if (seenId.has(h.checkpointId)) continue;
				seenId.add(h.checkpointId);
				const digest = computeContentDigest(h.summary).contentHash;
				if (seenDigest.has(digest)) continue;
				seenDigest.add(digest);
				out.push({ checkpointId: h.checkpointId, score: h.score, source: "fts5" });
			}
			return out;
		} catch {
			return [];
		}
	})();

	// ── Source C: recency (N freshest checkpoints, query-independent). ────────
	// Timestamp-ordered; the lower the index the fresher. Score = recency rank
	// (fresh = high) so normalization treats newest as best.
	const recencyCands: RecallCandidate[] = (() => {
		try {
			const cps = listCheckpoints(opts.sessionId, store.stateDir)
				.filter((c) => c.dedupStatus !== "removed")
				.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
				.slice(0, recencyCount);
			return cps.map((cp, i) => ({
				checkpointId: cp.checkpointId,
				// Fresher => higher raw score (recency rank). Normalized below.
				score: cps.length - i,
				source: "recency" as const,
			}));
		} catch {
			return [];
		}
	})();

	const sources: { name: string; cands: RecallCandidate[] }[] = [
		{ name: "vector", cands: vectorCands },
		{ name: "fts5", cands: fts5Cands },
		{ name: "recency", cands: recencyCands },
	];

	// Per-source normalization to 0..1 so the three scales are comparable.
	const perSource = sources.map((s) => ({
		name: s.name,
		norm: normalizeScores(s.cands.map((c) => c.score)),
	}));

	// Aggregate: best normalized score per source per checkpointId + vote count.
	const bestScoreBySource = new Map<string, Map<string, number>>();
	const seenIds = new Set<string>();
	for (const src of sources) {
		const norm = perSource.find((p) => p.name === src.name)!.norm;
		const bestByCp = new Map<string, number>();
		src.cands.forEach((c, i) => {
			// E1 follow-up: normalizeScores dropped non-finite scores; such a hit is
			// NOT a valid nomination — skip it entirely instead of defaulting it to
			// 0 (which would still name the checkpoint and let it rank last into the
			// fallback ranking).
			const n = norm.get(i);
			if (n === undefined) return;
			const prev = bestByCp.get(c.checkpointId);
			if (prev === undefined || n > prev) bestByCp.set(c.checkpointId, n);
			seenIds.add(c.checkpointId);
		});
		bestScoreBySource.set(src.name, bestByCp);
	}

	// Vote count = number of DISTINCT sources naming each checkpointId.
	const votes: Record<string, number> = {};
	const sumByCp = new Map<string, number>();
	for (const id of seenIds) {
		let count = 0;
		let sum = 0;
		for (const src of sources) {
			const m = bestScoreBySource.get(src.name)!;
			if (m.has(id)) {
				count++;
				sum += m.get(id)!;
			}
		}
		votes[id] = count;
		sumByCp.set(id, sum);
	}

	/** Mean normalized score across the sources that named `id`. */
	const meanScore = (id: string): number =>
		(sumByCp.get(id) ?? 0) / (votes[id] ?? 1);

	// Short-circuit: >=2 of 3 distinct sources => winner (agreement). Ranked by
	// vote count first (stronger agreement wins), then by mean normalized score —
	// the validator consumes this list in order and takes the first that passes,
	// so the ordering IS the ranking and must not be Set-insertion order.
	const winners: RecallCandidate[] = [];
	const divergent = new Set<string>(sources.map((s) => s.name));
	const agreed = [...seenIds]
		.filter((id) => (votes[id] ?? 0) >= 2)
		.sort((a, b) => (votes[b] ?? 0) - (votes[a] ?? 0) || meanScore(b) - meanScore(a));
	for (const id of agreed) {
		const cand = (() => {
			for (const src of sources) {
				const c = src.cands.find((x) => x.checkpointId === id);
				if (c) return c;
			}
			return null;
		})();
		if (cand) winners.push(cand);
	}

	if (winners.length === 0) {
		// Fallback (no 2-of-3 agreement): rank by cross-source MEAN normalized score.
		const ranked = [...seenIds].sort((a, b) => meanScore(b) - meanScore(a));
		for (const id of ranked) {
			const cand = (() => {
				for (const src of sources) {
					const c = src.cands.find((x) => x.checkpointId === id);
					if (c) return c;
				}
				return null;
			})();
			if (cand) winners.push(cand);
		}
	}

	// Divergence = a source that named NONE of the winning checkpoints. This must
	// be computed per SOURCE against the winning ID SET, not from `winner.source`
	// (a winner is one candidate object carrying a single source label, so an id
	// agreed on by all three sources would still credit only one of them).
	const winningIds = new Set(winners.map((w) => w.checkpointId));
	for (const src of sources) {
		if (src.cands.some((c) => winningIds.has(c.checkpointId))) {
			divergent.delete(src.name);
		}
	}

	if (divergent.size > 0) {
		logger.info("recall_vote_divergence", {
			divergentSources: [...divergent],
			winnerCount: winners.length,
		});
	}

	return {
		winners,
		votes,
		divergentSources: [...divergent],
	};
}
