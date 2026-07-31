/**
 * memoryStats.test.ts — memoryStats() TDD tests (S53B).
 *
 * Tests for src/memoryStats.ts: aggregates memory-store statistics from the
 * real SQLite store (totalMemories, 30-day window, top-N stable memories by
 * recall count, avgRecallScore).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStats } from "./memoryStats.js";
import { addMemory, recallMemory } from "./store/sqlite.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function newDir(): string {
	return mkdtempSync(join(tmpdir(), "mega-memoryStats-test-"));
}

beforeEach(() => {
	testDir = newDir();
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("memoryStats()", () => {
	it("returns zero counts when the store is empty", async () => {
		const stats = await memoryStats(testDir);
		assert.strictEqual(stats.totalMemories, 0, "empty store: totalMemories = 0");
		assert.strictEqual(
			stats.memoriesInLast30Days,
			0,
			"empty store: memoriesInLast30Days = 0",
		);
		assert.deepStrictEqual(
			stats.topStableMemories,
			[],
			"empty store: topStableMemories = []",
		);
		assert.ok(
			Number.isFinite(stats.avgRecallScore),
			"empty store: avgRecallScore is a number",
		);
	});

	it("totalMemories counts all memories in the store", async () => {
		addMemory({ content: "memory one" }, null, testDir);
		addMemory({ content: "memory two" }, null, testDir);
		addMemory({ content: "memory three" }, null, testDir);
		const stats = await memoryStats(testDir);
		assert.strictEqual(stats.totalMemories, 3, "totalMemories must be 3");
	});

	it("memoriesInLast30Days counts memories created within the window", async () => {
		// Memory created just now.
		addMemory({ content: "recent memory" }, null, testDir);
		// Old memory (simulate by directly setting lastRecalledAt far in the past).
		const oldId = addMemory({ content: "old memory" }, null, testDir);
		// Manually backdate oldId's createdAt by 60 days.
		const { openStore } = await import("./store/sqlite/utils.js");
		const db = openStore(testDir);
		const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 86_400;
		db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(sixtyDaysAgo, oldId);

		const stats = await memoryStats(testDir);
		assert.strictEqual(
			stats.memoriesInLast30Days,
			1,
			"only the recent memory should be in the 30-day window",
		);
	});

	it("topStableMemories returns up to topN memories sorted by recall count desc", async () => {
		// id=1: never recalled
		addMemory({ content: "never recalled memory" }, null, testDir);
		// id=2: recalled once
		const id2 = addMemory({ content: "recalled once memory" }, null, testDir);
		recallMemory(id2, testDir);
		// id=3: recalled 3 times
		const id3 = addMemory({ content: "recalled three times memory" }, null, testDir);
		recallMemory(id3, testDir);
		recallMemory(id3, testDir);
		recallMemory(id3, testDir);

		const stats = await memoryStats(testDir, { topN: 2 });
		assert.strictEqual(
			stats.topStableMemories.length,
			2,
			"topStableMemories must return at most topN entries",
		);
		assert.strictEqual(
			stats.topStableMemories[0].id,
			id3,
			"top entry must be the most-recalled memory",
		);
		assert.strictEqual(
			stats.topStableMemories[0].recallCount,
			3,
			"top entry recallCount must be 3",
		);
		assert.strictEqual(
			stats.topStableMemories[1].id,
			id2,
			"second entry must be the second-most-recalled",
		);
		assert.strictEqual(
			stats.topStableMemories[1].recallCount,
			1,
			"second entry recallCount must be 1",
		);
	});

	it("topStableMemories default topN is 5", async () => {
		for (let i = 0; i < 8; i++) {
			const id = addMemory({ content: `memory ${i}` }, null, testDir);
			for (let r = 0; r < i; r++) recallMemory(id, testDir);
		}
		const stats = await memoryStats(testDir); // no topN → defaults to 5
		assert.strictEqual(
			stats.topStableMemories.length,
			5,
			"default topN must be 5",
		);
	});

	it("avgRecallScore is the mean recallCount across all memories", async () => {
		const id1 = addMemory({ content: "score test 1" }, null, testDir);
		const id2 = addMemory({ content: "score test 2" }, null, testDir);
		recallMemory(id1, testDir); // 1 recall
		recallMemory(id2, testDir);
		recallMemory(id2, testDir); // 2 recalls
		// total recalls = 3, count = 2 → avg = 1.5
		const stats = await memoryStats(testDir);
		assert.strictEqual(
			stats.avgRecallScore,
			1.5,
			"avgRecallScore must be 1.5",
		);
	});

	it("avgRecallScore is 0 when no memory has been recalled", async () => {
		addMemory({ content: "no recall memory" }, null, testDir);
		addMemory({ content: "another no recall memory" }, null, testDir);
		const stats = await memoryStats(testDir);
		assert.strictEqual(stats.avgRecallScore, 0, "avgRecallScore must be 0 when no recalls");
	});

	it("avgRecallScore is 0 on an empty store", async () => {
		const stats = await memoryStats(testDir);
		assert.strictEqual(stats.avgRecallScore, 0, "avgRecallScore must be 0 on empty store");
	});

	it("lastRecalledAt is null when memory has never been recalled", async () => {
		const id = addMemory({ content: "never recalled" }, null, testDir);
		const stats = await memoryStats(testDir, { topN: 1 });
		const entry = stats.topStableMemories.find((m) => m.id === id);
		assert.ok(entry, "the memory should appear in topStableMemories");
		assert.strictEqual(
			entry!.lastRecalledAt,
			null,
			"lastRecalledAt must be null for never-recalled memory",
		);
	});

	it("lastRecalledAt is set when memory has been recalled", async () => {
		const id = addMemory({ content: "recalled at least once" }, null, testDir);
		recallMemory(id, testDir);
		const stats = await memoryStats(testDir, { topN: 1 });
		const entry = stats.topStableMemories.find((m) => m.id === id);
		assert.ok(entry, "the recalled memory should appear in topStableMemories");
		assert.ok(
			entry!.lastRecalledAt !== null && entry!.lastRecalledAt > 0,
			"lastRecalledAt must be a positive timestamp",
		);
	});

	it("memoriesInLast30Days is bounded by totalMemories", async () => {
		for (let i = 0; i < 10; i++) {
			addMemory({ content: `day ${i}` }, null, testDir);
		}
		const stats = await memoryStats(testDir);
		assert.ok(
			stats.memoriesInLast30Days <= stats.totalMemories,
			"30-day count cannot exceed total",
		);
	});

	it("topStableMemories includes memories that have never been recalled (recallCount=0)", async () => {
		// id=1: recalled once
		const id1 = addMemory({ content: "recalled once" }, null, testDir);
		recallMemory(id1, testDir);
		// id=2: never recalled
		addMemory({ content: "never recalled" }, null, testDir);

		const stats = await memoryStats(testDir, { topN: 2 });
		assert.strictEqual(stats.topStableMemories.length, 2, "must include never-recalled");
		const neverRecalled = stats.topStableMemories.find((m) => m.id === id1);
		const noRecall = stats.topStableMemories.find((m) => m.id !== id1);
		assert.ok(neverRecalled, "recalled memory must appear");
		assert.ok(noRecall, "never-recalled memory must appear too");
	});

	it("topStableMemories returns memories sorted by recallCount descending", async () => {
		const ids = [];
		for (let i = 0; i < 5; i++) {
			const id = addMemory({ content: `sorted memory ${i}` }, null, testDir);
			ids.push(id);
			for (let r = 0; r < 5 - i; r++) recallMemory(id, testDir);
		}
		const stats = await memoryStats(testDir, { topN: 5 });
		for (let i = 0; i < stats.topStableMemories.length - 1; i++) {
			assert.ok(
				stats.topStableMemories[i].recallCount >=
					stats.topStableMemories[i + 1].recallCount,
				`position ${i} recallCount must be >= position ${i + 1}`,
			);
		}
	});

	it("returns valid MemoryStatsResult shape", async () => {
		const stats = await memoryStats(testDir);
		assert.ok(typeof stats.totalMemories === "number", "totalMemories is a number");
		assert.ok(typeof stats.memoriesInLast30Days === "number", "memoriesInLast30Days is a number");
		assert.ok(Array.isArray(stats.topStableMemories), "topStableMemories is an array");
		assert.ok(typeof stats.avgRecallScore === "number", "avgRecallScore is a number");
		for (const m of stats.topStableMemories) {
			assert.ok(typeof m.id === "number", "each entry has a numeric id");
			assert.ok(typeof m.text === "string", "each entry has a text string");
			assert.ok(typeof m.recallCount === "number", "each entry has a numeric recallCount");
			assert.ok(
				m.lastRecalledAt === null || typeof m.lastRecalledAt === "number",
				"lastRecalledAt is null or number",
			);
		}
	});
});