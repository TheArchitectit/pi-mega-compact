/**
 * global-index.test.ts — S39 session heartbeats + token_samples round-trip.
 *
 * Verifies recordSessionHeartbeat + appendTokenSample + readActiveSessions +
 * readSessionTimeseries + pruneStaleSessions + pruneTokenSamples +
 * clearSessionHeartbeat, with particular focus on the Step 5 events.log
 * session_sample JSONL line shape (the SSE real-time push wire format).
 *
 * Pi-agnostic. Uses an isolated mock index dir (never the real user
 * `~/.mega-compact-index/` — guardrail G7). PREVENT-PI-004 (zero network):
 * every operation is local SQLite + local FS append.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";

import {
	recordSessionHeartbeat,
	appendTokenSample,
	readActiveSessions,
	readSessionTimeseries,
	pruneStaleSessions,
	pruneTokenSamples,
	clearSessionHeartbeat,
	closeIndexStore,
} from "./global-index.js";

describe("global-index session time-series (S39)", () => {
	let indexDir: string;
	let eventsLogPath: string;
	// Pinned, well-in-the-past base timestamp shared across the heartbeat +
	// token-sample tests so every Date.now()-vs-stored-ts comparison is
	// deterministic (no same-millisecond race). ~1e6 ms is unambiguously older
	// than any Date.now() cutoff the prune calls compute, so pruneStaleSessions
	// / pruneTokenSamples with maxAgeMs=0 (cutoff = Date.now()) always delete
	// the pinned rows; readActiveSessions has no freshness filter so it still
	// surfaces them; the readSessionTimeseries / prune `since` windows are
	// derived from tsBase so they always include the pinned samples.
	const tsBase = 1_000_000;

	before(() => {
		indexDir = mkdtempSync(join(tmpdir(), "mc-global-idx-"));
		eventsLogPath = join(indexDir, "events.log");
	});

	after(() => {
		closeIndexStore();
		rmSync(indexDir, { recursive: true, force: true });
	});

	it("recordSessionHeartbeat + readActiveSessions: heartbeat row appears", () => {
		recordSessionHeartbeat(
			12_345,
			"sess-abc-1",
			"/home/u/repos/proj-a",
			"/home/u/.pi/state-a",
			200_000,
			indexDir,
			tsBase, // pinned last_seen (deterministic; > 0)
		);
		const sessions = readActiveSessions(indexDir);
		assert.equal(sessions.length, 1);
		const s = sessions[0];
		assert.equal(s.pid, 12_345);
		assert.equal(s.sessionId, "sess-abc-1");
		assert.equal(s.repoRoot, "/home/u/repos/proj-a");
		assert.equal(s.stateDir, "/home/u/.pi/state-a");
		assert.equal(s.ctxWindow, 200_000);
		assert.ok(s.lastSeen > 0);
		// No token sample yet → tokens/percent are null.
		assert.equal(s.tokens, null);
		assert.equal(s.percent, null);
	});

	it("appendTokenSample writes a token_samples row + a session_sample JSONL line", () => {
		appendTokenSample(
			"sess-abc-1",
			"/home/u/repos/proj-a",
			42_000,
			21.5,
			200_000,
			eventsLogPath,
			indexDir,
		);
		// The token_samples row should now be the latest sample for this session.
		const sessions = readActiveSessions(indexDir);
		const s = sessions.find((x) => x.sessionId === "sess-abc-1");
		assert.ok(s, "session must still appear in readActiveSessions");
		assert.equal(s!.tokens, 42_000);
		assert.equal(s!.percent, 21.5);

		// The events.log JSONL line should exist and match the wire format
		// described by the SseSessionSample contract: an object with `ts`
		// (ISO 8601 string), `type: 'session_sample'`, and the payload fields.
		assert.ok(existsSync(eventsLogPath), "events.log should exist");
		const lines = readFileSync(eventsLogPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.equal(lines.length, 1, "exactly one JSONL line expected");
		const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
		assert.equal(parsed["type"], "session_sample");
		assert.equal(parsed["sessionId"], "sess-abc-1");
		assert.equal(parsed["tokens"], 42_000);
		assert.equal(parsed["percent"], 21.5);
		// Step 5 contract mirroring: `ts` is an ISO 8601 string (matches every
		// other SseEvent variant's `ts: string` and the DashboardEmitter
		// events.log pattern), NOT a numeric ms value.
		assert.equal(
			typeof parsed["ts"],
			"string",
			"ts must be an ISO 8601 string (matches other SseEvent variants)",
		);
		// Must be ISO-parseable (NaN if invalid → typeof won't be number).
		const tsMs = Date.parse(parsed["ts"] as string);
		assert.ok(
			Number.isFinite(tsMs),
			"ts must be a valid ISO 8601 timestamp",
		);
		// And recent (within the last 5s).
		assert.ok(
			Math.abs(Date.now() - tsMs) < 5_000,
			"ts must be within ~5s of now",
		);
	});

	it("readSessionTimeseries returns per-session series + totals in chronological order", () => {
		// Two sessions, two samples each — fully within the rolling window.
		// sess-xyz-9 needs its own heartbeat row so readActiveSessions can later
		// surface it (heartbeats are the primary key, not the samples).
		recordSessionHeartbeat(
			67_890,
			"sess-xyz-9",
			"/home/u/repos/proj-b",
			"/home/u/.pi/state-b",
			200_000,
			indexDir,
			tsBase + 1_000, // pinned last_seen (distinct from sess-abc-1's)
		);
		// Deterministic, 1ms-spaced sample timestamps off the shared pinned
		// tsBase so the per-ts totals map has exactly 3 distinct keys (not
		// collapsed by same-millisecond coincidence, which made totals.length
		// == 1 and tripped the >= 2 assertion — the pre-existing S39 flake).
		appendTokenSample(
			"sess-abc-1",
			"/home/u/repos/proj-a",
			50_000,
			25,
			200_000,
			null, // no events.log line for this assertion
			indexDir,
			tsBase, // 1st distinct timestamp
		);
		appendTokenSample(
			"sess-xyz-9",
			"/home/u/repos/proj-b",
			10_000,
			5,
			200_000,
			null,
			indexDir,
			tsBase + 1, // 2nd distinct timestamp (1ms later)
		);
		appendTokenSample(
			"sess-xyz-9",
			"/home/u/repos/proj-b",
			30_000,
			15,
			200_000,
			null,
			indexDir,
			tsBase + 2, // 3rd distinct timestamp (2ms later)
		);
		const since = tsBase - 60_000;
		const result = readSessionTimeseries(since, indexDir);

		const seriesIds = result.series.map((s) => s.sessionId).sort();
		assert.deepEqual(seriesIds, ["sess-abc-1", "sess-xyz-9"]);

		const xyz = result.series.find((s) => s.sessionId === "sess-xyz-9");
		assert.ok(xyz, "sess-xyz-9 series must exist");
		assert.equal(xyz!.data.length, 2);
		assert.equal(xyz!.data[0].tokens, 10_000);
		assert.equal(xyz!.data[1].tokens, 30_000);
		// Stable hash-based color from the SESSION_COLORS palette.
		assert.match(xyz!.color, /^#[0-9a-f]{6}$/i);

		// Totals: each timestamp summed across sessions.
		assert.ok(result.totals.length >= 2);
		for (const t of result.totals) {
			assert.ok(typeof t.ts === "number" && t.ts > 0);
			assert.ok(typeof t.tokens === "number" && t.tokens >= 0);
		}
		// Totals are sorted ascending by ts.
		for (let i = 1; i < result.totals.length; i++) {
			assert.ok(
				result.totals[i].ts >= result.totals[i - 1].ts,
				"totals must be chronologically ascending",
			);
		}
	});

	it("pruneStaleSessions clears heartbeats older than the cutoff (and only those)", () => {
		// At this point we have 2 sessions; both heartbeats are pinned to the
		// shared tsBase (well in the past), so a 0 ms cutoff (cutoff = Date.now())
		// unambiguously exceeds both last_seen values → both pruned.
		const beforeCount = readActiveSessions(indexDir).length;
		assert.equal(beforeCount, 2);

		// With a 0 ms cutoff, both are stale → pruned.
		const pruned = pruneStaleSessions(0, indexDir);
		assert.equal(pruned, 2, "both heartbeats should be pruned");
		assert.equal(readActiveSessions(indexDir).length, 0);
	});

	it("pruneTokenSamples clears token_samples older than the cutoff", () => {
		// The previously-written samples (sess-abc-1 + sess-xyz-9) are pinned to
		// the shared tsBase, so query from tsBase - 60s to find them. The
		// prunedStaleSessions call above left token_samples untouched (separate
		// table). A real-now sample from the earlier "appendTokenSample writes"
		// test also lives in the shared DB; it falls outside the tsBase-60s
		// `sinceBefore` window so it does not affect beforeCount, but it IS
		// pruned below. Prune with a NEGATIVE maxAge (cutoff = Date.now() + 60s,
		// safely in the future) so every row — including the real-now sample
		// whose ts may equal a 0-ms cutoff on a fast run — is deterministically
		// below the cutoff and deleted (no same-millisecond ts == cutoff race).
		const sinceBefore = tsBase - 60_000;
		const before = readSessionTimeseries(sinceBefore, indexDir);
		const beforeCount = before.series.reduce((n, s) => n + s.data.length, 0);
		assert.ok(beforeCount >= 3, "expected to find the seeded samples");

		const npurged = pruneTokenSamples(-60_000, indexDir);
		assert.ok(npurged >= 3, "should have pruned the seeded samples");

		const after = readSessionTimeseries(sinceBefore, indexDir);
		const afterCount = after.series.reduce((n, s) => n + s.data.length, 0);
		assert.equal(afterCount, 0, "no samples should remain after pruning");
	});

	it("clearSessionHeartbeat is a no-op on missing rows (never throws)", () => {
		const before = readActiveSessions(indexDir).length;
		assert.doesNotThrow(() =>
			clearSessionHeartbeat(99_999, "nonexistent-session", indexDir),
		);
		assert.equal(readActiveSessions(indexDir).length, before);
	});
});
