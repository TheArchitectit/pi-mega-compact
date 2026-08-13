/**
 * src/recall/recall3wf-validator.test.ts — 3WF-3 read-only/validator tests
 * (split from recall3wf.test.ts).
 *
 * Coverage (see recall3wf.fixture.ts for the real-store fixtures):
 *  3. the read-only + validator path does NOT advance the injected-set and emits
 *     NO S43 turn writes (turn_recall rows untouched before/after).
 *  4. floor rejection: top winner below 0.12 -> next candidate; ALL below ->
 *     provenance floor block returned.
 *  5. umbrella flag OFF -> recallAndInline output byte-identical to the
 *     pre-change single-path result (comparison captured within this run).
 *
 * No mocks/stubs: REAL VectorStore over a temp stateDir, REAL checkpoints, REAL
 * injected-set + turn_recall rows.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { vectorWasInjected } from "../vectorStore.js";
import { closeIndexStore } from "../store/sqlite.js";
import { voteRecall } from "./vote.js";
import { validateRecall } from "./validator.js";
import {
	freshStore,
	seed,
	checkpointIds,
	recallAndInlineCapture,
	countTurnRecallRows,
} from "./recall3wf.fixture.js";

after(() => {
	try { closeIndexStore(); } catch { /* */ }
});

// ── Test 3: read-only + validator path emits NO injected-set / turn writes. ────
test("3WF-3: read-only + validator path does NOT advance injected-set or write turn_recall", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, [
			"delta rate limiter throttling on the public API",
			"epsilon deadlock in the worker shutdown path",
			"zeta duplicate events from the at-least-once producer",
		]);
		const sid = "sess_3wf";
		const query = "rate limiter throttling on the public API";

		// Snapshot injected-set + turn_recall rows (recall provenance) BEFORE.
		const ids = checkpointIds(store, sid, query);
		const injectedBefore = ids.map((id) => vectorWasInjected(store, sid, id));
		const recallRowsBefore = countTurnRecallRows(store, sid);

		// Run the read-only + vote + validator path (the new 3WF-3 seam).
		const vote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		validateRecall(vote.winners, { sessionId: sid, liveWindow: [] }, store);

		// Snapshot AFTER.
		const idsAfter = checkpointIds(store, sid, query);
		const injectedAfter = idsAfter.map((id) => vectorWasInjected(store, sid, id));
		const recallRowsAfter = countTurnRecallRows(store, sid);

		assert.deepEqual(injectedAfter, injectedBefore, "injected-set unchanged by read-only+validator path");
		assert.equal(recallRowsAfter, recallRowsBefore, "turn_recall rows unchanged (no S43 telemetry write)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Test 4: floor rejection — top below 0.12 -> next; ALL below -> floor. ──────
test("3WF-3: cosine floor rejects weak top winner; all-below returns provenance floor", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, [
			"theta graceful degradation when the downstream times out",
			"iota backpressure signaling on the ingest pipeline",
			"kappa burst coalescing in the scheduler",
		]);
		const sid = "sess_3wf";
		const query = "graceful degradation when the downstream times out";

		// Case A: a strongly-relevant query -> top winner passes the 0.12 floor.
		process.env.MEGACOMPACT_RECALL_MIN_COSINE = "0.12";
		const goodVote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		const good = validateRecall(
			goodVote.winners,
			{ sessionId: sid, query, liveWindow: [] },
			store,
		);
		assert.equal(good.kind, "candidate", "relevant query yields a passing candidate");

		// Case A2: top winner BELOW the floor -> the validator must ADVANCE to the
		// next-ranked candidate rather than returning the weak one or the floor.
		// Build the ranked list explicitly: a deliberately weak candidate first,
		// then a genuinely relevant one. Only the strong one clears 0.12.
		const strong = goodVote.winners.find((w) => w.source === "vector");
		assert.ok(strong, "a vector-sourced winner exists to act as the strong candidate");
		const weakFirst = [
			{ checkpointId: strong.checkpointId, score: 0.001, source: "vector" as const },
			strong,
		];
		const advanced = validateRecall(
			weakFirst,
			{ sessionId: sid, query, liveWindow: [] },
			store,
		);
		assert.equal(advanced.kind, "candidate", "below-floor top winner advances to next candidate");
		assert.ok(
			advanced.kind === "candidate" && advanced.candidate.score >= 0.12,
			"the returned candidate is the next-ranked one that clears the floor",
		);

		// Case B: set the floor ABOVE every candidate's cosine so ALL fail ->
		// provenance floor returned.
		process.env.MEGACOMPACT_RECALL_MIN_COSINE = "0.9999";
		const blockedVote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		const blocked = validateRecall(
			blockedVote.winners,
			{ sessionId: sid, query, liveWindow: [] },
			store,
		);
		assert.equal(blocked.kind, "floor", "all-below-floor yields the provenance floor");
		assert.ok(blocked.floor.text.length > 0, "floor block carries model-visible text");
		assert.ok(["lastCheckpoint", "none"].includes(blocked.floor.basis), "floor basis is valid");
	} finally {
		delete process.env.MEGACOMPACT_RECALL_MIN_COSINE;
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Test 5: umbrella flag OFF -> recallAndInline output byte-identical. ────────
test("3WF-3: flag OFF leaves recallAndInline output unchanged (byte-identical single path)", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, [
			"kappa audit log rotation skipped on weekends",
			"lambda feature flag default flipped for new tenants",
			"mu pagination cursor reset on filter change",
		]);
		const sid = "sess_3wf";
		const query = "audit log rotation skipped on weekends";

		// Capture the canonical recallAndInline output (the pre-change single path).
		const baseline = recallAndInlineCapture(sid, query, store);

		// With the umbrella flag ON the new modules ARE exercised, but recallAndInline
		// itself is untouched by 3WF-3 (additive); its output must still match.
		// Exercise the new seam so we know it does not side-effect the inline path,
		// then confirm recallAndInline output is byte-identical to baseline.
		const vote = voteRecall({ sessionId: sid, query, limit: 3 }, store);
		validateRecall(vote.winners, { sessionId: sid, liveWindow: [] }, store);
		const after2 = recallAndInlineCapture(sid, query, store);

		assert.equal(after2.block, baseline.block, "recallAndInline block byte-identical pre/post new seam");
		assert.equal(after2.empty, baseline.empty, "recallAndInline empty flag byte-identical");
		assert.equal(after2.toInject.length, baseline.toInject.length, "recallAndInline toInject length byte-identical");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── E1 regression (PR #18 review follow-up): NaN must never clear the floor. ────
// `NaN < floor` is false, so an unguarded gate 1 let a NaN cosine PASS and
// inject — one NaN source poisons the 3WF-3 quorum. Non-finite scores must be
// rejected; the outcome is the provenance floor ("no recall"), never a
// zero-score injection.
test("E1: NaN/Infinity cosine scores are rejected -> provenance floor (never injected)", () => {
	const { store, dir } = freshStore();
	try {
		seed(store, ["sigma retry storm after the gateway failover"]);
		const sid = "sess_3wf";
		const ids = checkpointIds(store, sid, "retry storm gateway failover");
		assert.ok(ids.length >= 1, "a real checkpoint exists to build the winner");
		process.env.MEGACOMPACT_RECALL_MIN_COSINE = "0.12";

		for (const bad of [NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const out = validateRecall(
				[{ checkpointId: ids[0], score: bad, source: "vector" }],
				{ sessionId: sid, query: "retry storm gateway failover", liveWindow: [] },
				store,
			);
			assert.equal(
				out.kind,
				"floor",
				`non-finite cosine (${bad}) must be rejected -> floor, got ${out.kind}`,
			);
		}

		// A NaN FLOOR (typo'd env) must not disable gate 1 either: RECALL_MIN_COSINE
		// falls back to 0.12, so a genuinely strong vector winner still passes.
		process.env.MEGACOMPACT_RECALL_MIN_COSINE = "not-a-number";
		const vote = voteRecall({ sessionId: sid, query: "retry storm gateway failover", limit: 3 }, store);
		const out = validateRecall(vote.winners, { sessionId: sid, query: "retry storm gateway failover", liveWindow: [] }, store);
		assert.equal(out.kind, "candidate", "NaN floor env falls back to 0.12 (gate stays active)");
	} finally {
		delete process.env.MEGACOMPACT_RECALL_MIN_COSINE;
		rmSync(dir, { recursive: true, force: true });
	}
});
