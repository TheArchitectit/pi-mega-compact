/**
 * add-l0.ts — the L0 exact-match tier of the dedup cascade.
 *
 * L0 is three exact-hash probes sharing one enable flag and one MARK_ONLY flag:
 *   1. contentHash — normalized dual-hash, bloom-accelerated (Sprint 9/10)
 *   2. regionHash  — the legacy pre-normalization hash (backward-compat)
 *   3. summaryHash — same-topic incremental compactions
 *
 * Split out of add.ts so both files stay under the 300-line src/ soft limit.
 * The tier is a pure decision: it either produces a collapse (returning the
 * matched result) or reports the fall-through, and it never writes a new
 * checkpoint — that stays in add.ts.
 *
 * All three probes are hash comparisons, so none of them computes a similarity
 * score and none is invented for the audit trail.
 */
import { createHash } from "node:crypto";
import type { StoredCheckpoint } from "../store.js";
import type { ContentDigest } from "../dedup/digest.js";
import { upsertCheckpoint, addTokensSaved, bumpDedupStats } from "../store/sqlite.js";
import type { BloomFilter } from "../store/bloom.js";
import type { DedupAuditRecorder } from "./dedup-audit.js";
import type { AddInput, AddResult } from "./types.js";
import type { VectorStore } from "./class.js";

/** Everything the L0 tier needs from the enclosing add() cascade. */
export interface L0Context {
	store: VectorStore;
	input: AddInput;
	/** Checkpoints already stored for this session. */
	all: StoredCheckpoint[];
	/** Normalized content digest of the incoming region. */
	digest: ContentDigest;
	/** Legacy region hash of the incoming region. */
	regionHash: string;
	/** SHA-256 of the topic summary, when one was supplied. */
	summaryHash?: string;
	/** Tokens the original region occupied (the dedup "saved" base). */
	origTokens: number;
	/** Warm bloom accelerator for the content-hash probe. */
	bloom: BloomFilter;
	/** Cascade start time, for the monitoring latency figure. */
	t0: number;
	audit: DedupAuditRecorder;
}

/**
 * Outcome of the L0 tier.
 *
 * `result` set → the tier collapsed the region and add() returns immediately.
 * `markOnly` set → a probe matched but MARK_ONLY policy said store anyway, so
 * the cascade continues and records the mark at the end.
 */
export interface L0Outcome {
	result?: AddResult;
	markOnly: "L0" | null;
}

/** Run the L0 exact-match tier. */
export function runL0Tier(ctx: L0Context): L0Outcome {
	const { store, input, all, digest, regionHash, origTokens, bloom, t0, audit } = ctx;
	const cfg = store.cfg;
	const onTier = input.onTier;
	let markOnly: "L0" | null = null;

	// 0. Content-hash dedup (Sprint 9) — catches identical content arriving under
	//    different regionText. Normalization handles case/whitespace/ANSI so
	//    variants collapse to one row. Dual-hash guards a single-hash collision.
	//    Sprint 10: bloom is the accelerator — a miss means "definitely new" and
	//    skips the scan; a hit is only a candidate, confirmed against `all` here.
	//    MARK_ONLY_L0 records the decision but does not collapse.
	onTier?.({ tier: "L0", status: "scanning" });
	if (cfg.L0_ENABLED && bloom.maybeHas(digest.contentHash)) {
		const contentMatch = all.find(
			(cp) =>
				cp.contentHash === digest.contentHash &&
				cp.contentHash2 === digest.contentHash2,
		);
		if (contentMatch) {
			if (cfg.MARK_ONLY_L0) {
				markOnly = "L0"; // Record-but-don't-collapse: fall through.
			} else {
				contentMatch.timestamp = input.timestamp;
				upsertCheckpoint(contentMatch, store.stateDir);
				bumpDedupStats(true, store.stateDir);
				// Deduped: whole original region discarded, nothing new stored.
				addTokensSaved(origTokens, store.stateDir);
				store.record("L0", "deduped", "contentHash", Date.now() - t0, 1, contentMatch.checkpointId);
				audit.deduped("L0", contentMatch.checkpointId, "contentHash");
				onTier?.({ tier: "L0", status: "deduped", detail: "contentHash" });
				return {
					result: { checkpoint: contentMatch, deduped: true, reason: "contentHash" },
					markOnly,
				};
			}
		}
	}

	// 1. Legacy regionHash dedup (backward-compat) — part of L0 tier gating.
	if (cfg.L0_ENABLED) {
		const regionMatch = all.find((cp) => cp.regionHash === regionHash);
		if (regionMatch) {
			if (cfg.MARK_ONLY_L0) {
				markOnly = "L0"; // fall through
			} else {
				bumpDedupStats(true, store.stateDir);
				// Deduped: whole original region discarded, nothing new stored.
				addTokensSaved(origTokens, store.stateDir);
				store.record("L0", "deduped", "regionHash", Date.now() - t0, 1, regionMatch.checkpointId);
				audit.deduped("L0", regionMatch.checkpointId, "regionHash");
				onTier?.({ tier: "L0", status: "deduped", detail: "regionHash" });
				return {
					result: { checkpoint: regionMatch, deduped: true, reason: "regionHash" },
					markOnly,
				};
			}
		}
	}

	// 2. SummaryHash dedup — catches same-topic incremental compactions.
	if (ctx.summaryHash && cfg.L0_ENABLED) {
		const summaryMatch = all.find((cp) => cp.summaryHash === ctx.summaryHash);
		if (summaryMatch) {
			if (cfg.MARK_ONLY_L0) {
				markOnly = "L0"; // fall through
			} else {
				summaryMatch.timestamp = input.timestamp;
				upsertCheckpoint(summaryMatch, store.stateDir);
				bumpDedupStats(true, store.stateDir);
				// Deduped: whole original region discarded, nothing new stored.
				addTokensSaved(origTokens, store.stateDir);
				store.record("L0", "deduped", "summaryHash", Date.now() - t0, 1, summaryMatch.checkpointId);
				audit.deduped("L0", summaryMatch.checkpointId, "summaryHash");
				onTier?.({ tier: "L0", status: "deduped", detail: "summaryHash" });
				return {
					result: { checkpoint: summaryMatch, deduped: true, reason: "summaryHash" },
					markOnly,
				};
			}
		}
	}
	// L0 did not collapse this region.
	onTier?.({ tier: "L0", status: "passed" });
	return { markOnly };
}

/** SHA-256 of the topic summary (full 64-hex; 16-hex was collision-prone). */
export function computeSummaryHash(topicSummary?: string): string | undefined {
	return topicSummary
		? createHash("sha256").update(topicSummary).digest("hex")
		: undefined;
}
