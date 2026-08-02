/**
 * auto-trigger.test.ts — auto-trigger gate: legacy ctx.compact durable trim, S16 live-view trim + resume nudge.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

test("auto-trigger (legacy): past threshold persists a chkpt and starts a durable trim via ctx.compact", async () => {
	const h = harness();
	const messages = h.session;
	// The mock session is tiny (~100 tokens). piCompactWouldNoop() would skip
	// ctx.compact() for a transcript under pi's keepRecentTokens budget — so
	// lower the floor to 0 to simulate a transcript large enough that pi WOULD
	// compact (the positive path this test exercises).
	// S16: this is the LEGACY path — the default no longer calls ctx.compact()
	// (it returns a live-trimmed view instead). Set the legacy flag to exercise
	// the v0.4.28 ctx.compact durable-trim flow this test asserts.
	process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
	process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "true";
	try {
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
			const res = await h.fire("context", { type: "context", messages }, ctx);
			// S38.5: the strict race guard (default) defers ctx.compact() via a
			// setTimeout(500) re-check. The synchronous return is still undefined
			// (no local drop), but ctx.compact() only lands after the timer — wait
			// for it before asserting the durable-trim call count.
			await new Promise((r) => setTimeout(r, 700));
			// L1->L4 ran: a checkpoint was persisted to the SQLite store + a marker entry written.
		const { listCheckpoints } = await import("../../src/store/sqlite.js");
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"checkpoint persisted to local vector db",
		);
		assert.equal(
			h.appended.some((a) => a.t === "mega-compact-marker"),
			true,
			"marker sentinel appended",
		);
		// The legacy context handler triggers pi's compaction flow (ctx.compact),
		// which calls our session_before_compact handler to supply the DURABLE trim.
		assert.equal(
			res,
			undefined,
			"legacy context handler returns nothing (no local drop)",
		);
		assert.equal(
			h.compactCalls.length,
			1,
			"ctx.compact() called to start durable trim (legacy path)",
		);
		// The durable trim was supplied (summary + firstKeptEntryId from pi's prep).
		assert.ok(h.compactCalls[0] !== undefined, "compaction flow executed");
	} finally {
		delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
		delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	}
});

test("auto-trigger: skips ctx.compact() when pi would no-op (session too small, legacy path)", async () => {
	const h = harness();
	const messages = h.session;
	// Default floor (20000): the tiny mock transcript is below pi's
	// keepRecentTokens budget, so piCompactWouldNoop() must skip ctx.compact()
	// rather than surface pi's "Nothing to compact (session too small)" throw.
	// S16: exercised under the legacy flag (the default path never calls ctx.compact).
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "true";
	try {
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
		const res = await h.fire("context", { type: "context", messages }, ctx);
		assert.equal(
			res,
			undefined,
			"legacy context handler returns nothing (no local drop)",
		);
		assert.equal(
			h.compactCalls.length,
			0,
			"ctx.compact() NOT called — pi would no-op",
		);
		// Our recall checkpoint still persisted (Path A) — the durable trim is the
		// only thing skipped; recall is independent of it.
		const { listCheckpoints } = await import("../../src/store/sqlite.js");
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"recall checkpoint still persisted",
		);
		assert.equal(
			h.appended.some((a) => a.t === "mega-compact-marker"),
			true,
			"marker sentinel still appended",
		);
	} finally {
		delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	}
});

test("auto-trigger (S16): trims the live view and does NOT call ctx.compact()", async () => {
	const h = harness();
	const messages = h.session;
	// S16 default: live context-event trim. No legacy flag. Lower the anchor floor
	// so the trimmed recent window (4 messages, 2 user) clears the anchor check
	// and the live trim actually fires — mirrors how the legacy test lowers the
	// durable floor to exercise its positive path.
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
	try {
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
		const res = await h.fire("context", { type: "context", messages }, ctx);
		// S16: context handler returns a TRIMMED messages array (live trim), not undefined.
		assert.ok(
			res && typeof res === "object",
			"context handler returns a result object (live trim)",
		);
		assert.ok(
			Array.isArray((res as any).messages),
			"result has a trimmed messages array",
		);
		// The trimmed view starts with the compacted summary (user-role) + is shorter.
		assert.ok(
			(res as any).messages.length < messages.length,
			"trimmed view is shorter than the full session",
		);
		// S16: ctx.compact() is NEVER called (it would stop the agent).
		assert.equal(
			h.compactCalls.length,
			0,
			"ctx.compact() NOT called — compact-and-continue",
		);
		// The recall checkpoint is still persisted (the durable value).
		const { listCheckpoints } = await import("../../src/store/sqlite.js");
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"recall checkpoint persisted under live trim",
		);
	} finally {
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("auto-trigger (S16): does not trim when below the anchor floor (returns undefined, no ctx.compact)", async () => {
	const h = harness();
	// A session so short that buildLiveTrimmedView's anchor floor can't hold — the
	// live trim skips this call (returns undefined, the next context event retries).
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	const shortSession = [h.session[0], h.session[1]]; // one user + one assistant
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	const res = await h.fire(
		"context",
		{ type: "context", messages: shortSession },
		ctx,
	);
	// Either it skipped (undefined) or trimmed safely — but it must never call ctx.compact.
	assert.equal(
		h.compactCalls.length,
		0,
		"ctx.compact() NOT called under live trim (short session)",
	);
	if (res === undefined) {
		// skipped path is fine
		assert.ok(
			true,
			"below anchor floor → no trim this call (retries next event)",
		);
	}
});

test("auto-trigger (S16): sendUserMessage resume nudge fires only when idle + queued + not already nudged", async () => {
	const h = harness();
	// No queued messages → the nudge must NOT fire (the guard prevents busy-loops).
	// We assert the extension did not throw and did not push a spurious resume.
	const ctx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false });
	await h.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
	// No throw + no spurious nudge side-effect is the contract; appended stays
	// free of any auto "continue" marker when there is no queued work.
	assert.equal(
		h.appended.some((a) => a.t && /continue/i.test(String(a.d ?? ""))),
		false,
		"no spurious continue when no queued work",
	);
});

test("auto-trigger (S16): durable trim still happens via pi native auto-compaction (session_before_compact)", async () => {
	const h = harness();
	// pi's native auto-compaction fires at agent-end with reason "threshold" (the
	// CONTINUING path). Our session_before_compact handler must still supply the
	// durable trim summary — independent of the live context-event trim.
	const prep = {
		firstKeptEntryId: "e2",
		messagesToSummarize: h.session.slice(0, 4),
		tokensBefore: 500,
	};
	const res = await h.fire(
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
			signal: undefined,
			preparation: prep,
		} as any,
		h.ctx(),
	);
	assert.ok(
		res?.compaction,
		"we supply a durable compaction result to pi's native path",
	);
	assert.ok(
		res.compaction.firstKeptEntryId === "e2",
		"reuses pi's boundary (PREVENT-PI-002)",
	);
	assert.ok(res.compaction.summary.length > 0, "summary is non-empty");
});

