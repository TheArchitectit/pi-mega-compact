/**
 * degenerate.ts — the degenerate-checkpoint predicate + the L1/L2 collapse guard.
 *
 * WHY THIS EXISTS (incident 2026-08-19). A defect in the summarizer could emit a
 * DEGENERATE summary: a ~30-40 token structural skeleton with no informational
 * content, e.g.
 *
 *   "Conversation: 64 messages (5 user, 29 assistant, 27 tool). Tools: bash, edit, read."
 *
 * Once such a checkpoint landed in the store it became an absorbing state. Every
 * later compaction produced a structurally identical skeleton, so L1 MinHash and
 * L2 cosine (0.872 against a 0.85 threshold) matched it EVERY time — each add()
 * returned `deduped: true`, discarded the incoming content, and only bumped the
 * stored skeleton's timestamp. The store could never heal, even after the
 * summarizer was fixed, because a rich new summary that happened to match the
 * skeleton would still be swallowed by it.
 *
 * THE GUARD. When L1 or L2 finds a match, we ask whether the MATCHED (stored)
 * checkpoint is degenerate and the incoming candidate is RICHER. If both hold, we
 * decline the collapse and let the cascade continue as if nothing matched — so a
 * fresh, informative checkpoint is written and the skeleton stops absorbing.
 *
 * Direction matters: only "poor stored ← rich incoming" is unblocked. Two equal
 * skeletons still collapse (dedup is doing its job), and a rich stored
 * checkpoint absorbing a poor incoming one is left alone — that is ordinary
 * dedup, not the pathology.
 *
 * PREVENT-PI-004: pure arithmetic over already-loaded fields. No IO, no network.
 */
import type { StoredCheckpoint } from "../store.js";

/** The tunables the guard reads (thread from DedupConfigShape). */
export interface DegenerateGuardTunables {
	/** Umbrella flag. OFF ⇒ the guard never fires (byte-identical predecessor). */
	readonly DEDUP_DEGENERATE_GUARD: boolean;
	/** Absolute token floor below which a stored summary is structural, not informational. */
	readonly DEDUP_DEGEN_MIN_TOKENS: number;
	/** Relative floor as a fraction of the ORIGINAL region the summary stands in for. */
	readonly DEDUP_DEGEN_MIN_PCT: number;
}

/** The two fields the predicate scores. Kept structural so tests need no full row. */
export interface DegenerateSubject {
	tokenEstimate?: number;
	originalTokenEstimate?: number;
}

/**
 * The effective token floor for a checkpoint: the larger of the absolute floor
 * and `MIN_PCT × originalTokenEstimate`.
 *
 * A missing / zero / non-finite `originalTokenEstimate` contributes nothing, so
 * the absolute floor applies alone — direct add() callers and pre-v0.4 rows that
 * never recorded the original region size are judged on absolute size only,
 * never accidentally deemed degenerate by a 0-valued percentage term.
 */
export function degenerateFloor(
	subject: DegenerateSubject,
	tunables: DegenerateGuardTunables,
): number {
	const orig = subject.originalTokenEstimate;
	const relative =
		typeof orig === "number" && Number.isFinite(orig) && orig > 0
			? orig * tunables.DEDUP_DEGEN_MIN_PCT
			: 0;
	return Math.max(tunables.DEDUP_DEGEN_MIN_TOKENS, relative);
}

/**
 * Is this stored checkpoint a degenerate (content-free) summary?
 *
 * Calibration against the incident data:
 *  - skeleton: tokenEstimate 34, original ≈19166 → 34 < max(48, 95.8) → TRUE
 *  - normal:   tokenEstimate 2000, original 70000 → 2000 > max(48, 350) → FALSE
 *
 * The relative term is what makes this scale: a 34-token summary of a 900-token
 * region is a legitimate 26× compression, while the same 34 tokens standing in
 * for 19k is a skeleton.
 */
export function isDegenerateCheckpoint(
	subject: DegenerateSubject,
	tunables: DegenerateGuardTunables,
): boolean {
	const tokens = subject.tokenEstimate ?? 0;
	return tokens < degenerateFloor(subject, tunables);
}

/**
 * Should an L1/L2 match be DECLINED because it would collapse richer incoming
 * content onto a degenerate stored checkpoint?
 *
 * Returns true only when all four hold:
 *   1. the umbrella flag is ON,
 *   2. the matched (stored) checkpoint is degenerate,
 *   3. the candidate is strictly richer than the match,
 *   4. the candidate's content is not byte-identical to the match's.
 *
 * Condition 3 uses a strict `>`: equal-size skeletons collapsing is harmless and
 * keeps the store from growing one row per compaction while the summarizer is
 * broken. Only a genuine improvement is worth declining a collapse for.
 *
 * Condition 4 is a CORRECTNESS requirement, not a refinement. `context_chunks`
 * carries a partial UNIQUE index on (session_id, content_hash) (schema/core.ts
 * QA #1), so declining a match whose content hash already exists would fall
 * through to an INSERT that throws — inside add(), which sits on the agent loop.
 * It is also the semantically right call: identical bytes are the SAME region,
 * so re-storing them adds no information and heals nothing. Only L0 may own the
 * exact-match case; the guard exists for fuzzy matches on genuinely different
 * text, which is exactly the incident's shape (each compaction produced a
 * *similar but distinct* skeleton).
 */
export function shouldSkipDegenerateMatch(
	matched: StoredCheckpoint,
	candidate: DegenerateSubject & { contentHash?: string },
	tunables: DegenerateGuardTunables,
): boolean {
	if (!tunables.DEDUP_DEGENERATE_GUARD) return false;
	if (!isDegenerateCheckpoint(matched, tunables)) return false;
	if ((candidate.tokenEstimate ?? 0) <= (matched.tokenEstimate ?? 0)) return false;
	// Byte-identical content → not a healing opportunity (and would violate the
	// UNIQUE index). Compared only when both hashes are known.
	const a = candidate.contentHash;
	const b = matched.contentHash;
	return !(a !== undefined && b !== undefined && a === b);
}
