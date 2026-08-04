/**
 * add-l1.ts — the L1 MinHash/LSH near-duplicate lookup.
 *
 * Split out of add.ts to keep both files under the 300-line src/ soft limit.
 * L1 catches the one-word edits and rewordings L0's exact hashes miss: a cheap
 * LSH bucket retrieval narrows the field, then a trigram verification
 * (pg_trgm-equivalent) is the final gate. The verify is boolean, so the tier
 * produces no similarity score.
 */
import type { StoredCheckpoint } from "../store.js";
import {
	minhashSignature,
	SIGNATURE_VERSION,
	NUM_HASHES,
} from "../dedup/l1-minhash.js";
import { lshBands } from "../dedup/l1-lsh.js";
import { isNearDuplicate } from "../dedup/l1-verify.js";
import { lshCandidateChunks } from "../store/sqlite.js";
import type { VectorStore } from "./class.js";

export /**
 * L1 near-duplicate lookup: MinHash → LSH candidate retrieval → trigram verify.
 * Returns the matching checkpoint or undefined. Bounded by a 100-candidate cap
 * and a 20ms verify budget (QA #7/#15) so it never hangs a large session.
 */
function findL1Duplicate(
	store: VectorStore,
	sessionId: string,
	regionText: string,
	all: StoredCheckpoint[],
): StoredCheckpoint | undefined {
	if (all.length === 0) return undefined;
	const sig = minhashSignature(regionText);
	if (sig.length !== NUM_HASHES) return undefined;
	const bands = lshBands(sig, sessionId, SIGNATURE_VERSION);
	// Cheap candidate retrieval (single query, capped). Exclude nothing yet —
	// the new checkpoint has no id, so pass a sentinel that never matches.
	const candidateIds = lshCandidateChunks(
		bands,
		sessionId,
		"__new__",
		store.stateDir,
		100,
	);
	if (candidateIds.length === 0) return undefined;
	const byId = new Map(all.map((cp) => [cp.checkpointId, cp]));
	const VERIFY_BUDGET_MS = 20;
	const start = Date.now();
	for (const id of candidateIds) {
		if (Date.now() - start > VERIFY_BUDGET_MS) break; // QA #15: abort → "not dup"
		const cand = byId.get(id);
		if (!cand) continue;
		const candText = cand.normalizedText ?? cand.summary ?? "";
		if (isNearDuplicate(regionText, candText)) return cand;
	}
	return undefined;
}
