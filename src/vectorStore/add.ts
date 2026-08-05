/**
 * add.ts — the dedup cascade behind VectorStore.add() (extracted from class.ts).
 *
 * Free function taking the store as its first argument, matching the sibling
 * pattern used by vector-read.ts / vector-search.ts / vector-dedup.ts: the
 * store's fields are package-public by design (see the comment in class.ts) so
 * the helpers can read them without casts, and class.ts stays a thin shell.
 *
 * Cascade order (unchanged by the extraction):
 *   1. L0 contentHash exact match (bloom-accelerated)
 *   2. L0 legacy regionHash exact match (backward-compat)
 *   3. L0 summaryHash exact match (same-topic incremental compactions)
 *   4. L1 MinHash/LSH near-duplicate
 *   5. L2 cosine similarity >= threshold
 *   6. None matched → create a new checkpoint
 *
 * Sprint-14 monitoring (`store.record`) and the live `onTier` UI hook are
 * untouched. The dedup audit trail (external-audit item #2) is layered on top as
 * PURE instrumentation: every emit is best-effort and flag-gated, so a flag-off
 * or a failing write leaves the dedup outcome byte-identical.
 */
import { cosineSimilarity } from "../embedder.js";
import type { StoredCheckpoint } from "../store.js";
import { normalizeSessionId, compressSmart } from "../store.js";
import { computeContentDigest } from "../dedup/digest.js";
import { minhashSignature, SIGNATURE_VERSION } from "../dedup/l1-minhash.js";
import { lshBands } from "../dedup/l1-lsh.js";
import { openBloom, saveBloom } from "../store/bloom.js";
import {
	listCheckpoints,
	nextCheckpointId,
	upsertCheckpoint,
	loadSessionState,
	saveSessionState,
	upsertMinhashSignature,
	insertLshBuckets,
	addTokensSaved,
	bumpDedupStats,
} from "../store/sqlite.js";
import { computeRegionHash } from "./hash.js";
import { runL0Tier, computeSummaryHash } from "./add-l0.js";
import { findL1Duplicate } from "./add-l1.js";
import { dedupAuditRecorder } from "./dedup-audit.js";
import type { VectorStore } from "./class.js";
import type { AddInput, AddResult } from "./types.js";

/**
 * Add a checkpoint, running the full dedup cascade.
 *
 * Returns the matched checkpoint with `deduped: true` when a tier collapsed the
 * region, otherwise the newly created checkpoint with `deduped: false`.
 */
export function addCheckpoint(store: VectorStore, input: AddInput): AddResult {
	const t0 = Date.now();
	const sessionId = normalizeSessionId(input.sessionId);
	const regionHash = computeRegionHash(input.regionText);
	const all = listCheckpoints(sessionId, store.stateDir);
	// Honest "tokens saved" base for this region. For a deduped add the whole
	// original region is discarded (nothing new stored); for a new checkpoint
	// we persist (orig − stored). Falls back to stored when orig is unknown.
	const origTokens = input.originalTokenEstimate ?? input.tokenEstimate ?? 0;
	const cfg = store.cfg;
	// Live per-tier progress hook (Phase 1). Sync + optional; fired at each tier
	// so the UI can paint "L0 ✓ → L1 ✓ → L2 0.91 → stored" during a compaction.
	const onTier = input.onTier;
	// Durable decision trail (external-audit item #2). Bound to this one cascade
	// so each call site is a single line; a no-op when cfg.DEDUP_AUDIT is off.
	const audit = dedupAuditRecorder(
		{
			stateDir: store.stateDir,
			eventsPath: store.eventsPath,
			auditEnabled: cfg.DEDUP_AUDIT,
		},
		{
			sessionId,
			originalTokenEstimate: input.originalTokenEstimate,
			tokenEstimate: input.tokenEstimate,
		},
	);
	// Tracks whether a tier matched while in MARK_ONLY (record-but-don't-collapse),
	// and which tier.
	let markOnly: "L0" | "L1" | "L2" | null = null;

	// L0 exact-match tier (contentHash / regionHash / summaryHash) — see add-l0.ts.
	const digest = computeContentDigest(input.regionText);
	const bloom = openBloom(store.stateDir);
	const summaryHash = computeSummaryHash(input.topicSummary);
	const l0 = runL0Tier({
		store,
		input,
		all,
		digest,
		regionHash,
		summaryHash,
		origTokens,
		bloom,
		t0,
		audit,
	});
	if (l0.result) return l0.result;
	if (l0.markOnly) markOnly = l0.markOnly;

	// 2b. L1 MinHash/LSH near-duplicate dedup (Sprint 11) — catches one-word
	//     edits / rewordings that L0's exact hash misses. Cheap LSH bucket
	//     retrieval → trigram verification (pg_trgm-equivalent) as the final gate.
	//     Gated by L1_ENABLED (Sprint 14); MARK_ONLY_L1 records but doesn't collapse.
	onTier?.({ tier: "L1", status: "scanning" });
	if (cfg.L1_ENABLED) {
		const l1 = findL1Duplicate(store, sessionId, input.regionText, all);
		if (l1 && !cfg.MARK_ONLY_L1) {
			l1.timestamp = input.timestamp;
			upsertCheckpoint(l1, store.stateDir);
			bumpDedupStats(true, store.stateDir);
			const r = { checkpoint: l1, deduped: true, reason: "l1MinHash" };
			store.record("L1", "deduped", "l1MinHash", Date.now() - t0, 1, l1.checkpointId);
			// Verify tier: the trigram gate is a boolean, so no score is invented.
			audit.deduped("L1", l1.checkpointId, "l1MinHash");
			onTier?.({ tier: "L1", status: "deduped", detail: "l1MinHash" });
			return r;
		}
		if (l1 && cfg.MARK_ONLY_L1) markOnly = "L1";
	}
	onTier?.({ tier: "L1", status: "passed" });

	// 3. L2 semantic dedup — catches near-identical / semantically-similar regions
	//    via cosine over the embedding. topicSummary is used for summaryHash dedup
	//    (tier 2); the vector index is keyed on the original region for backward-
	//    compat search semantics. Threshold from cfg (L2_COSINE trigram honest
	//    firing point). QA #13 timeout guard: if the O(n) scan exceeds the budget,
	//    degrade to "store without dedup this pass" so we never lose a checkpoint.
	//    Gated by L2_ENABLED (Sprint 14); MARK_ONLY_L2 records but doesn't collapse.
	const SIMILARITY_BUDGET_MS = cfg.SIMILARITY_BUDGET_MS;
	const simThreshold = store.l2Threshold; // from cfg.L2_COSINE (default 0.85 trigram)
	const embedding = store.embedder.embed(input.regionText);
	onTier?.({ tier: "L2", status: "scanning" });
	if (cfg.L2_ENABLED && all.length > 0) {
		const start = Date.now();
		let timedOut = false;
		const nearest = all.reduce(
			(best, cp) => {
				if (!timedOut && Date.now() - start > SIMILARITY_BUDGET_MS)
					timedOut = true;
				if (timedOut) return best;
				const sim = cosineSimilarity(embedding, cp.embedding);
				return sim > best.sim ? { checkpoint: cp, sim } : best;
			},
			{ checkpoint: all[0], sim: -1 },
		);
		if (!timedOut && nearest.sim >= simThreshold) {
			if (!cfg.MARK_ONLY_L2) {
				// Near-identical — update timestamp on existing checkpoint
				nearest.checkpoint.timestamp = input.timestamp;
				upsertCheckpoint(nearest.checkpoint, store.stateDir);
				bumpDedupStats(true, store.stateDir);
				// Deduped: whole original region discarded, nothing new stored.
				addTokensSaved(origTokens, store.stateDir);
				const r = {
					checkpoint: nearest.checkpoint,
					deduped: true,
					reason: "contentSimilarity",
				};
				store.record("L2", "deduped", "contentSimilarity", Date.now() - t0, nearest.sim, nearest.checkpoint.checkpointId);
				// The real cosine that cleared the threshold — the tuning datum.
				audit.deduped(
					"L2",
					nearest.checkpoint.checkpointId,
					"contentSimilarity",
					nearest.sim,
				);
				onTier?.({
					tier: "L2",
					status: "deduped",
					detail: nearest.sim.toFixed(2),
				});
				return r;
			}
			markOnly = "L2";
		}
		onTier?.({
			tier: "L2",
			status: "passed",
			detail: `best ${nearest.sim.toFixed(2)}`,
		});
		// Near-miss: how close did we come to collapsing? Only emitted when the
		// scan actually completed and scored a candidate — a timed-out scan has no
		// honest best to report.
		if (!timedOut && nearest.sim >= 0) {
			audit.passed("L2", nearest.checkpoint.checkpointId, nearest.sim);
		}
	}

	// 4. Genuinely new — create checkpoint
	const checkpointId = nextCheckpointId(sessionId, store.stateDir);
	const checkpoint: StoredCheckpoint = {
		checkpointId,
		sessionId,
		repoId: store.repoId,
		summary: input.summary,
		topicSummary: input.topicSummary,
		summaryHash,
		keyDecisions: input.keyDecisions ?? [],
		nextSteps: input.nextSteps ?? [],
		filesModified: input.filesModified ?? [],
		tokenEstimate: input.tokenEstimate ?? 0,
		originalTokenEstimate: input.originalTokenEstimate,
		regionHash,
		contentHash: digest.contentHash,
		contentHash2: digest.contentHash2,
		contentHashVersion: digest.contentHashVersion,
		normalizedText: digest.normalizedText,
		compressedOriginal: compressSmart(
			Buffer.from(input.regionText, "utf-8"),
			input.compressionPressure,
		),
		embedding,
		timestamp: input.timestamp,
	};
	// Persistence is SQLite (store/sqlite.ts). upsertCheckpoint keeps the
	// idempotent-by-id semantics the old JSON append implied.
	upsertCheckpoint(checkpoint, store.stateDir);
	// Cumulative "tokens saved" counter (per-repo SQLite meta). For a NEW
	// checkpoint the saved amount is (original − stored); for a deduped add the
	// whole original region is discarded (handled in the deduped return paths
	// above). Survives sessions and travels with the repo.
	const stored = input.tokenEstimate ?? 0;
	addTokensSaved(Math.max(0, origTokens - stored), store.stateDir);
	// L1: persist this checkpoint's MinHash signature + LSH buckets so future
	// near-duplicate inserts can find it. Deterministic given the seed.
	const sig = minhashSignature(input.regionText);
	upsertMinhashSignature(
		checkpointId,
		sessionId,
		SIGNATURE_VERSION,
		sig,
		store.stateDir,
	);
	insertLshBuckets(
		checkpointId,
		sessionId,
		SIGNATURE_VERSION,
		lshBands(sig, sessionId, SIGNATURE_VERSION),
		store.stateDir,
	);
	// Bloom accelerator: record the new content_hash so a future add() can short-
	// circuit the scan on a hit (still confirmed by the SELECT-based `all` above).
	bloom.add(digest.contentHash);
	saveBloom(store.stateDir);

	// Track the region hash in session state for fast sentinel checks.
	const state = loadSessionState(sessionId, store.stateDir);
	if (!state.storedRegionHashes.includes(regionHash)) {
		state.storedRegionHashes.push(regionHash);
		saveSessionState(sessionId, state, store.stateDir);
	}
	// A new checkpoint. If a tier matched while MARK_ONLY, record that (the
	// decision fired but we intentionally did not collapse).
	if (markOnly) {
		store.record(markOnly, "mark_only", "mark_only", Date.now() - t0);
	} else {
		store.record("L0", "new", undefined, Date.now() - t0);
	}
	// Final outcome. `mark_only` distinguishes "a tier matched but policy said
	// store anyway" from a genuinely novel region.
	audit.stored(checkpointId, markOnly ? "mark_only" : "new", stored);
	// Cumulative store-wide dedup accounting (attempt, not collapsed).
	bumpDedupStats(false, store.stateDir);
	onTier?.({ tier: "new", status: "stored" });
	return { checkpoint, deduped: false };
}
