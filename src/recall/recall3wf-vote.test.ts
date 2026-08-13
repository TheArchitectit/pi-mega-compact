/**
 * src/recall/recall3wf-vote.test.ts — 3WF-3 vote-path tests (split from recall3wf.test.ts).
 *
 * Coverage (see recall3wf.fixture.ts for the real-store fixtures):
 *  1. each source returns its hits; the vote union is deduped by checkpointId.
 *  1b. sources B (fts5) + C (recency) genuinely contribute — regression guard
 *     against the dead-source / vector-only degeneration.
 *  2. injected-set interplay does NOT distort overlap (vote keys on raw hits,
 *     unaffected by vectorMarkInjected — unlike newHits would be).
 *
 * No mocks/stubs: REAL VectorStore over a temp stateDir, REAL checkpoints, REAL
 * injected-set. Only assertions import node:test here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { vectorMarkInjected, vectorWasInjected, vectorSemDedup, vectorList } from "../vectorStore.js";
import { closeIndexStore } from "../store/sqlite.js";
import { recallRawHits } from "./readonly.js";
import { voteRecall, normalizeScores } from "./vote.js";
import { freshStore, seed, checkpointIds } from "./recall3wf.fixture.js";

after(() => {
	try { closeIndexStore(); } catch { /* */ }
});

// ── Test 1: each source returns hits; vote union deduped by checkpointId. ─────
test("3WF-3: each source contributes + vote union is deduped by checkpointId", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, [
			"the webhook retry queue keeps dropping messages under load",
			"the token budget overflowed during the large migration",
			"the cache invalidation fired on every key rotation",
		]);
		const sid = "sess_3wf";
		const query = "webhook retry queue dropping messages";

		// Source A: vector — raw hits for the query.
		const vec = recallRawHits({ sessionId: sid, query, limit: 3 }, store);
		assert.ok(vec.length >= 1, "vector source returns at least one hit");

		// Full vote.
		const vote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		assert.ok(vote.winners.length >= 1, "vote produces winners");
		const ids = vote.winners.map((w) => w.checkpointId);
		assert.equal(new Set(ids).size, ids.length, "winners are deduped by checkpointId");
		for (const id of Object.keys(vote.votes)) {
			assert.ok(vote.votes[id] >= 1 && vote.votes[id] <= 3, "vote count within [1,3]");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Test 1b: sources B + C are genuinely wired (regression guard). ────────────
// The vote must NOT degenerate to vector-only. Source B (fts5) and Source C
// (recency) both depend on the SQLITE listCheckpoints; importing the same-named
// legacy gzipped-JSON helper from src/store.ts returns [] for live sessions,
// which silently starves both sources while every other assertion still passes
// (the vector source alone still produces winners). Assert real multi-source
// agreement so that regression cannot return unnoticed.
test("3WF-3: fts5 + recency sources actually contribute (no vector-only degeneration)", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, [
			"the webhook retry queue keeps dropping messages under load",
			"the token budget overflowed during the large migration",
			"the cache invalidation fired on every key rotation",
		]);
		const sid = "sess_3wf";
		const query = "webhook retry queue dropping messages";

		// Source C (recency) is query-independent and always names N checkpoints,
		// so with a seeded store SOME id must carry >= 2 votes (vector + recency).
		const vote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		const counts = Object.values(vote.votes);
		assert.ok(counts.length > 0, "vote produced candidates");
		assert.ok(
			Math.max(...counts) >= 2,
			`expected multi-source agreement (>=2 votes) but got ${JSON.stringify(vote.votes)} — sources B/C are starved`,
		);
		// Neither recency nor fts5 may be reported divergent when they named a winner.
		assert.ok(
			!vote.divergentSources.includes("recency"),
			`recency named winners so it must not be divergent: ${JSON.stringify(vote.divergentSources)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Test 2: injected-set interplay does NOT distort overlap (raw hits). ────────
test("3WF-3: marking checkpoints injected does NOT change the raw vote (unlike newHits)", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, [
			"alpha billing reconciliation gap in the ledger",
			"beta connection pool exhaustion under burst traffic",
			"gamma schema migration added a nullable column",
		]);
		const sid = "sess_3wf";
		const query = "billing reconciliation gap in the ledger";

		const before = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		const beforeIds = before.winners.map((w) => w.checkpointId).sort();

		// Mark ALL checkpoints injected — this WOULD drop them from newHits (the
		// skipInjected-filtered path), but the vote keys on raw hits, so it must
		// be unaffected.
		for (const id of checkpointIds(store, sid, query)) {
			vectorMarkInjected(store, sid, id);
		}
		// Confirm the injected-set actually changed for at least one id.
		const someId = checkpointIds(store, sid, query)[0];
		assert.ok(vectorWasInjected(store, sid, someId), "injected-set was mutated for the probe");

		const after = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		const afterIds = after.winners.map((w) => w.checkpointId).sort();
		assert.deepEqual(afterIds, beforeIds, "raw-hits vote is unaffected by injected-set marking");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── E1 regression (PR #18 review follow-up): NaN must not poison the quorum. ────
// normalizeScores folds scores through Math.min/Math.max — a single NaN turned
// EVERY normalized score of that source into NaN. Non-finite scores are now
// dropped (exported so the guard is directly testable; real scores come from
// cosine/BM25/recency, all finite by construction on the default embedder).
test("E1: normalizeScores drops non-finite scores instead of poisoning the source", () => {
	const norm = normalizeScores([0.5, NaN, 0.9]);
	assert.equal(norm.size, 2, "the NaN entry is dropped, not folded");
	assert.equal(norm.get(0), 0, "min of the finite pair normalizes to 0");
	assert.equal(norm.get(2), 1, "max of the finite pair normalizes to 1");
	assert.equal(norm.get(1), undefined, "dropped index carries no score");

	assert.equal(normalizeScores([NaN, Infinity, -Infinity]).size, 0, "all-non-finite source yields no votes");
	assert.equal(normalizeScores([]).size, 0, "empty source stays empty");
	assert.equal(normalizeScores([0.7]).get(0), 1, "single finite score normalizes to 1 (span 0)");
});

// ── H1 regression (PR #18 review follow-up): a 'removed' row must never be
// nominated by ANY vote source — including fts5, whose FTS5 index is NOT pruned
// by SemDeDup. Pre-fix, hydrateFts5Hits hydrated removed rows, letting a dead
// checkpoint win the 2/3 agreement (fts5 name + recency) and re-enter recall.
// Seed the near-dup pair DIRECTLY (sprint12's pattern: summary=text, embedding=
// embed(text)) so SemDeDup's cosine gate lands predictably — compactSession's
// boilerplate summary prefix dilutes the cosine below the removal threshold.
test("H1: a SemDeDup-'removed' row is never nominated by any vote source", async () => {
	const { store, dir } = freshStore();
	const { upsertCheckpoint } = await import("../store/sqlite.js");
	const { defaultEmbedder } = await import("../embedder.js");
	try {
		const sid = "sess_3wf_h1";
		const e = defaultEmbedder();
		const rows = [
			{ id: "chkpt_001", text: "the nightly batch job reindexed the search cluster", tok: 100, ts: 1 },
			{ id: "chkpt_002", text: "the nightly batch job reindexed the search cluster again", tok: 200, ts: 2 },
			{ id: "chkpt_003", text: "the billing ledger reconciled every cent that quarter", tok: 150, ts: 3 },
		];
		for (const r of rows) {
			upsertCheckpoint(
				{
					checkpointId: r.id,
					sessionId: sid,
					summary: r.text,
					keyDecisions: [],
					nextSteps: [],
					filesModified: [],
					tokenEstimate: r.tok,
					regionHash: `r-${r.id}`,
					embedding: e.embed(r.text),
					timestamp: r.ts,
				},
				dir,
			);
		}
		const removedCount = vectorSemDedup(store, sid, 0.8);
		assert.ok(removedCount >= 1, "SemDeDup removed the near-dup pair member");
		const removedIds = vectorList(store, sid)
			.filter((c) => c.dedupStatus === "removed")
			.map((c) => c.checkpointId);

		// Query with the removed row's exact-ish text so FTS5 trigram + recency
		// both WANT to name it. No source may.
		const query = "nightly batch job reindexed the search cluster";
		const vote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		for (const id of removedIds) {
			assert.ok(!(id in vote.votes), `removed row ${id} got ${vote.votes[id]} vote(s) — a source nominated it`);
			assert.ok(
				!vote.winners.some((w) => w.checkpointId === id),
				`removed row ${id} is a vote winner`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
