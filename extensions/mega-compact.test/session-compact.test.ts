/**
 * session-compact.test.ts — session_before_compact durable-trim summary supply.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

test("session_before_compact supplies our durable trim (not pi's summary)", async () => {
	const h = harness();
	// pi fires session_before_compact with its own computed preparation.
	const res = await h.fire(
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "overflow",
			willRetry: true,
			preparation: {
				firstKeptEntryId: "e2",
				messagesToSummarize: h.session.slice(0, 2),
				tokensBefore: 500,
			},
			signal: undefined,
		} as any,
		h.ctx(),
	);
	assert.ok(res && res.compaction, "returns a compaction result");
	assert.equal(
		res.compaction.firstKeptEntryId,
		"e2",
		"reuses pi's cut boundary (PREVENT-PI-002 safe)",
	);
	assert.ok(
		typeof res.compaction.summary === "string" &&
			res.compaction.summary.length > 0,
		"our summary supplied",
	);
	assert.ok(res.compaction.tokensBefore >= 0, "tokensBefore reported");
});

test("session_before_compact supplies a fallback summary when nothing to summarize", async () => {
	const h = harness();
	// Empty preparation → no messages to summarize (anchor floor protects
	// everything). We MUST still supply a compaction (never {}), otherwise pi
	// runs its own compact() which throws "Nothing to compact (session too
	// small)" and leaves the session stuck with no resume context. The fallback
	// records a minimal resume summary so the session always resumes.
	const res = await h.fire(
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
			preparation: {
				firstKeptEntryId: "e0",
				messagesToSummarize: [],
				tokensBefore: 0,
			},
			signal: undefined,
		} as any,
		h.ctx(),
	);
	assert.ok(
		res && (res as any).compaction,
		"fallback compaction supplied (never {})",
	);
	assert.ok(
		(res as any).compaction.summary.includes("context compacted"),
		"fallback summary injected so the session resumes",
	);
	assert.equal(
		(res as any).compaction.firstKeptEntryId,
		"e0",
		"keeps pi's cut point",
	);
});

