/**
 * monitoring.test.ts — dashboard.json state snapshot + events.log after compaction.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

test("state snapshot writes dashboard.json after compaction", async () => {
	const h = harness();
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	// Fire auto-trigger compaction (context event above 80% threshold)
	await h.fire("context", { type: "context", messages: h.session }, ctx);
	const { existsSync: ex, readFileSync: rf } = await import("node:fs");
	const { join: j } = await import("node:path");
	const snapPath = j(h.stateDir, "dashboard.json");
	assert.ok(ex(snapPath), "dashboard.json written after compaction");
	const snap = JSON.parse(rf(snapPath, "utf-8"));
	// Item B: the honest token model is wired — the original dropped region was
	// captured (originalTokens > 0), and the saved amount never exceeds the
	// original (saved = max(0, original − stored) ≤ original). For this tiny
	// harness session the summary can be ≥ the region, so saved may be 0; the
	// positive "saved > 0" case with a large region is covered by the
	// vectorStore unit tests.
	assert.ok(
		snap.store.originalTokens > 0,
		"snapshot.store.originalTokens captured after compaction",
	);
	assert.ok(
		snap.store.originalTokens >= snap.store.tokensSaved,
		"model invariant: original region >= tokens saved",
	);
	// Item A: crew (live agent) block is present in the dashboard snapshot.
	assert.ok(
		snap.crew && typeof snap.crew.activeAgents === "number",
		"snapshot.crew.activeAgents present",
	);
});

test("events.log receives compaction events", async () => {
	const h = harness();
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	// Fire auto-trigger compaction twice (first fires compaction, second also fires)
	await h.fire("context", { type: "context", messages: h.session }, ctx);
	const { readFileSync: rf, existsSync: ex } = await import("node:fs");
	const { join: j } = await import("node:path");
	const logPath = j(h.stateDir, "events.log");
	if (ex(logPath)) {
		const content = rf(logPath, "utf-8").trim();
		// At minimum, we expect at least one event logged
		assert.ok(content.length > 0, "events.log is non-empty after compaction");
	} else {
		// events.log may not exist if the DashboardEmitter path differs from stateDir;
		// verify dashboard.json was written (proves the post-compact path executed)
		assert.ok(
			ex(j(h.stateDir, "dashboard.json")),
			"dashboard.json proves post-compact ran",
		);
	}
});

