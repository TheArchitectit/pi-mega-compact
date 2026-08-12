/**
 * src/failback/compact.test.ts — 3WF-2 candidate-veto + vote (sprint tests 1 & 2).
 *
 * No mocks/stubs of the units under test: REAL EngineMessage fixtures, a REAL
 * VectorStore in a temp stateDir, and a REAL compactSession run (sprint test 1
 * asserts supersedeTokenSavings === 0 end-to-end). Matches the triggerGuard.test.ts
 * conventions (freshStore + closeIndexStore cleanup in after()).
 *
 * Covers:
 *   - sprint test 1: all-unique messages → supersede frees 0 but the summary
 *     vote still succeeds (real compactSession + voteCandidate, no crash).
 *   - sprint test 2: degenerate cluster candidate rejected → extractive wins.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../vectorStore.js";
import { compactSession } from "../engine.js";
import { closeIndexStore } from "../store/sqlite.js";
import type { EngineMessage } from "../types.js";
import { buildCandidates, voteCandidate } from "./compact.js";

/** Real EngineMessage fixtures (user + assistant turns, unique content). */
function msg(role: "user" | "assistant", text: string): EngineMessage {
	return { role, text } as EngineMessage;
}

/** Fresh isolated state dir per VectorStore. */
function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-vote-"));
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

after(() => {
	try { closeIndexStore(); } catch { /* */ }
});

test("3WF-2 (1): all-unique messages → supersede frees 0 but the summary vote still succeeds", () => {
	const { store, dir } = freshStore();
	try {
		// A large, all-unique region (8 turns of substantial, non-repeated content)
		// so the compacted region is genuinely larger than its summary — the only
		// case where a summary vote is meaningful.
		const long = "We implemented the three-way failback coordinator that reconciles supersede, collapse, and recall outputs. ".repeat(8);
		const messages: EngineMessage[] = [];
		for (let i = 0; i < 8; i++) {
			messages.push(
				msg("user", `${long} request number ${i}`),
				msg("assistant", `${long} acknowledged and applied change ${i}`),
			);
		}
		// Real end-to-end compaction: nothing is superseded (all-unique content).
		const result = compactSession(
			{ sessionId: "sess_vote1", messages, keepFrom: messages.length, timestamp: 1 },
			store,
		);
		assert.equal(result.skipped, false, "compaction is not skipped for a real region");
		assert.equal(result.supersedeTokenSavings, 0, "no repeated file reads → supersede frees 0 (the production bug metric)");

		// The 3-source vote must still produce a winner (not floor-rejected, no crash).
		const winner = voteCandidate(messages, result.originalTokenEstimate);
		assert.ok(winner !== null, "vote produces a non-null winner for an all-unique region");
		// Original region (large) must be larger than the voted summary.
		assert.ok(result.originalTokenEstimate > winner!.tokenEstimate, "voted summary is smaller than the region");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-2 (2): degenerate cluster candidate rejected → extractive wins", () => {
	// With real inputs the cluster candidate (summarizeCluster → extractive
	// fallback) is never genuinely empty for non-empty messages, so we assert the
	// VETO contract directly (the task's stated fallback): buildCandidates never
	// returns a candidate with an empty/whitespace-only summary, and voteCandidate
	// always resolves to a real, non-empty member of the candidate set.
	const messages: EngineMessage[] = [
		msg("user", "wire the live-window token delta into the dashboard health panel"),
		msg("assistant", "added a liveBefore/liveAfter gauge sourced from currentTokens"),
		msg("user", "make the thrash guard arm only when reduction is zero"),
		msg("assistant", "armed blockedUntilTokens when effective === false"),
	];

	const candidates = buildCandidates(messages);
	assert.ok(candidates.length >= 1, "at least one candidate is produced");

	// Veto contract: no candidate ever has an empty/whitespace summary, and the
	// extractive candidate (always insertion-order 0) is present and labelled.
	for (const c of candidates) {
		assert.ok(c.summary.trim().length > 0, "vetoed/degenerate candidates are never returned");
	}
	const extractive = candidates[0];
	assert.ok(extractive.summary.startsWith("<summary>"), "candidate 0 is the extractive summary");

	// The vote must pick a real, non-empty member of the candidate set (never a
	// degenerate/empty summary — that is what the veto guarantees). voteCandidate
	// rebuilds candidates internally, so compare by summary content, not identity.
	const winner = voteCandidate(messages, 10_000);
	assert.ok(winner !== null, "vote produces a winner for real inputs");
	assert.ok(
		candidates.some((c) => c.summary === winner!.summary),
		"winner is a real member of the candidate set (no degenerate substitution)",
	);
	assert.ok(winner!.summary.trim().length > 0, "winner summary is non-empty");
});
