/**
 * recall/validator.ts — independent candidate validator (3WF-3).
 *
 * Judges candidates handed to it; it MUST NOT call any search itself. Given the
 * ranked vote winners + the live-window text (already extracted by the caller,
 * since src/ cannot import pi types), it walks the winners in order and returns
 * the first that passes BOTH gates:
 *
 *   1. Cosine floor: the winner's score >= the same-repo floor (default 0.12,
 *      env MEGACOMPACT_RECALL_MIN_COSINE). The cross-repo 0.90 floor
 *      (config.crossRepoCosine) is SEPARATE and intentionally untouched.
 *   2. Not already resident in the live window: reuse recall/sync.ts's exact
 *      comparison — embed each live message, embed the checkpoint summary, and
 *      treat the checkpoint as resident when cosineSimilarity >= dedupSim. We
 *      reuse that metric rather than inventing a new one.
 *
 * On a failing candidate it advances to the next-ranked winner. If ALL fail it
 * returns the provenance floor (FloorBlock built from the newest checkpoint —
 * pure over checkpoints, same semantics as triggerGuard's buildFloorBlock).
 *
 * Non-fatal throughout: any error degrades to the next candidate / the floor.
 * Pi-agnostic: no pi runtime imports.
 */
import { defaultEmbedder, cosineSimilarity } from "../embedder.js";
// SQLite store, NOT src/store.ts's legacy gzipped-JSON DR reader (that returns
// [] for live sessions). Mirrors vector-search.ts / tieredRouter.ts.
import { listCheckpoints } from "../store/sqlite.js";
import { RECALL_MIN_COSINE } from "../config.js";
import type { VectorStore } from "../vectorStore.js";
import type { RecallCandidate, FloorBlock } from "../failback/types.js";
import {
	buildFloorBlock as sharedFloorBlock,
	unavailableFloorBlock,
} from "../failback/floor.js";

/** Options for the recall validator. */
export interface ValidateOptions {
	/** Normalized session id (for floor-block construction). */
	sessionId: string;
	/**
	 * The recall query. Required for a TRUE cosine gate: only `source:"vector"`
	 * candidates carry a cosine in `score` (fts5 carries BM25, recency carries a
	 * freshness rank), so comparing a raw mixed-scale score against a cosine
	 * floor would be meaningless. When supplied, the validator re-derives each
	 * candidate's cosine against the query locally (embedder only — never a
	 * search call, so the "independent of all three search calls" contract
	 * holds). When omitted, only `vector` candidates can clear the gate.
	 */
	query?: string;
	/** Live-window message texts already extracted by the caller. */
	liveWindow?: string[];
	/** Dedup similarity threshold for the live-window resident check. */
	dedupSim?: number;
}

/** A validated winner, or the provenance floor when all candidates fail. */
export type ValidationOutcome =
	| { kind: "candidate"; candidate: RecallCandidate }
	| { kind: "floor"; floor: FloorBlock };

/**
 * Build the provenance floor block from the session's newest checkpoint.
 *
 * 3WF-4: the text construction moved to the SHARED pure builder
 * (src/failback/floor.ts). This wrapper keeps THIS call site's read semantics —
 * `listCheckpoints` filtered to `dedupStatus !== "removed"` — so the output is
 * byte-identical to the pre-refactor 3WF-3 version.
 */
function buildFloorBlock(sessionId: string, store: VectorStore): FloorBlock {
	try {
		const cps = listCheckpoints(sessionId, store.stateDir).filter(
			(c) => c.dedupStatus !== "removed",
		);
		return sharedFloorBlock(cps);
	} catch {
		return unavailableFloorBlock();
	}
}

/**
 * Validate the ranked vote winners, returning the first that passes both gates,
 * or the provenance floor if none do. Does NOT mutate the injected set, does NOT
 * write turns, does NOT emit telemetry. Non-fatal.
 */
export function validateRecall(
	winners: RecallCandidate[],
	opts: ValidateOptions,
	store: VectorStore,
): ValidationOutcome {
	const floor = RECALL_MIN_COSINE();
	const dedupSim = opts.dedupSim ?? 0.9;
	const embedder = defaultEmbedder();
	const liveVecs = (opts.liveWindow ?? []).map((m) => embedder.embed(m));
	// One checkpoint read for the whole pass (both gates share it).
	const cps = listCheckpoints(opts.sessionId, store.stateDir);
	const cpById = new Map(cps.map((c) => [c.checkpointId, c]));
	const queryVec = opts.query ? embedder.embed(opts.query) : null;

	for (const cand of winners) {
		try {
			const cp = cpById.get(cand.checkpointId);

			// Gate 1: same-repo COSINE floor. `cand.score` is only a cosine for
			// source "vector"; fts5 (BM25) and recency (freshness rank) live on
			// other scales, so for those we re-derive the true cosine locally from
			// the query + checkpoint embedding. No search call is made.
			let cosine: number;
			if (cand.source === "vector") {
				cosine = cand.score;
			} else if (queryVec && cp) {
				cosine = cosineSimilarity(queryVec, embedder.embed(cp.summary));
			} else {
				// No comparable cosine available => cannot clear a cosine gate.
				continue;
			}
			// E1 follow-up (PR #18 review): NaN/Infinity must NEVER clear the floor.
			// `NaN < floor` is false, so an unguarded comparison lets a NaN cosine
			// PASS gate 1 and inject — one NaN source poisons the whole 3WF-3
			// quorum. Reject non-finite scores explicitly; the candidate is skipped
			// and, if all fail, the provenance floor ("no recall") is returned —
			// never a zero-score injection. The default TrigramEmbedder cannot
			// produce NaN (zero-norm guard), but a BYO localhost embedder can.
			if (!Number.isFinite(cosine) || cosine < floor) continue;

			// Gate 2: not already resident in the live window.
			if (liveVecs.length > 0) {
				if (!cp) continue; // cannot verify => skip rather than risk re-inject
				const hitVec = embedder.embed(cp.summary);
				const resident = liveVecs.some(
					(v) => cosineSimilarity(v, hitVec) >= dedupSim,
				);
				if (resident) continue;
			}

			return { kind: "candidate", candidate: cand };
		} catch {
			// Non-fatal: skip this candidate, try the next.
			continue;
		}
	}

	// All candidates rejected -> provenance floor.
	return { kind: "floor", floor: buildFloorBlock(opts.sessionId, store) };
}
