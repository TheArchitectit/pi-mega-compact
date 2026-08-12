/**
 * src/failback/compact.ts — 3WF-2 candidate-veto + vote module (pure, advisory).
 *
 * The production bug this fixes: compaction "succeeded" (a checkpoint was
 * persisted, `saved` grew) while the LIVE WINDOW (`currentTokens`) never
 * shrank — because `saved` is a cumulative SQLite total, not the working-set
 * delta. This module builds competing summary candidates (extractive vs
 * cluster/raptor) and VOTES which one, if any, is worth replacing the
 * supersede-only result. It is purely advisory/observational: it never mutates
 * a checkpoint, never overwrites `result.summary`, and returning `null` means
 * "keep the supersede-only result" — the caller must NOT substitute a summary.
 *
 * Pure: no store mutation, no I/O, no network, no console.*. pi-agnostic
 * (imports only from src/). Designed for the 3WF umbrella flag gate at the
 * extension layer (see extensions/mega-pipeline/compact/vote.ts).
 */

import type { EngineMessage } from "../types.js";
import { collectRecentUserRequests, summarizeMessages } from "../compact.js";
import { summarizeCluster } from "../dedup/raptor/summarizer.js";
import { estimateBlockTokens } from "../tokens.js";
import type { CompactCandidate } from "./types.js";

/**
 * Default floor (tokens of net reduction) below which a candidate vote is
 * REJECTED, returning `null` (keep the supersede-only result).
 *
 * Rationale: a candidate that reduces the region by fewer than 1 token is not
 * meaningfully smaller than the compacted region it would replace — swapping
 * the supersede-only result for it buys nothing and only adds a (possibly
 * less faithful) summary. The floor therefore requires the voted summary to be
 * STRICTLY smaller than the compacted region. Set to 1 (minimally defensible:
 * the summary must actually be smaller). Overridable via `opts.floor`.
 */
export const DEFAULT_VOTE_FLOOR_TOKENS = 1;

/** Strip a trailing ellipsis/truncation marker from a needle before containment. */
function stripEllipsis(s: string): string {
	// collectRecentUserRequests truncates to 160 chars via compact.ts's truncate,
	// which appends the U+2026 ellipsis when it cuts. Drop it for a fair test.
	return s.replace(/…\s*$/u, "").trim();
}

/** Normalize for containment: collapse whitespace, lowercase. */
function normalize(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when `summary` contains the content of EVERY recent user request. */
export function signalPreserved(summary: string, messages: EngineMessage[]): boolean {
	const requests = collectRecentUserRequests(messages, 3);
	if (requests.length === 0) return true; // nothing to preserve
	const haystack = normalize(summary);
	return requests.every((r) => haystack.includes(normalize(stripEllipsis(r))));
}

/**
 * Build the two competing candidates (extractive + cluster/raptor) for a
 * compacted message region. Degenerate (empty/whitespace-only) summaries are
 * VETOED — never returned. Both candidates use estimateBlockTokens(summary) for
 * a single consistent token basis so the vote compares like with like (the
 * cluster path's own tokenEstimate is intentionally ignored for fairness).
 */
export function buildCandidates(messages: EngineMessage[]): CompactCandidate[] {
	const out: CompactCandidate[] = [];

	const extractive = summarizeMessages(messages);
	if (extractive.trim().length > 0) {
		out.push({
			source: "extractive",
			summary: extractive,
			tokenEstimate: estimateBlockTokens(extractive),
			signalPreserved: signalPreserved(extractive, messages),
		});
	}

	// summarizeCluster returns deterministic extractive when MEGACOMPACT_RAPTOR_MODEL
	// is unset and the local-only Ollama variant when set — so using it makes the
	// Ollama path an insertion that adds NO new LLM call site for the on-by-default
	// extraction. No behavior change for the default config.
	const cluster = summarizeCluster(messages).summary;
	if (cluster.trim().length > 0) {
		out.push({
			source: "cluster",
			summary: cluster,
			tokenEstimate: estimateBlockTokens(cluster),
			signalPreserved: signalPreserved(cluster, messages),
		});
	}

	return out;
}

/**
 * Vote the best candidate. `score = reduction * (signalPreserved ? 1 : 0.5)`
 * where `reduction = tokensBefore - candidate.tokenEstimate`. Ties resolve to
 * the EARLIER (extractive) candidate for determinism. Returns `null` when the
 * winner's score is below `opts.floor` (default DEFAULT_VOTE_FLOOR_TOKENS) —
 * caller MUST keep the supersede-only result and must NOT substitute a summary.
 */
export function voteCandidate(
	messages: EngineMessage[],
	tokensBefore: number,
	opts: { floor?: number } = {},
): CompactCandidate | null {
	const floor = opts.floor ?? DEFAULT_VOTE_FLOOR_TOKENS;
	const candidates = buildCandidates(messages);
	let best: CompactCandidate | null = null;
	let bestScore = -Infinity;
	for (const c of candidates) {
		const reduction = tokensBefore - c.tokenEstimate;
		const score = reduction * (c.signalPreserved ? 1 : 0.5);
		// Earlier candidate wins ties (strict > keeps insertion order = extractive first).
		if (score > bestScore) {
			bestScore = score;
			best = c;
		}
	}
	if (best === null) return null;
	if (bestScore < floor) return null;
	return best;
}
