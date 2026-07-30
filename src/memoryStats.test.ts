/**
 * memoryStats.test.ts — S53B durable-memory effectiveness aggregates.
 *
 * Seeds the `memories` table via addMemory and the `turn_recall` provenance
 * table via direct SQL inserts into turns.db (openTurnStore), then exercises
 * readMemoryEffectiveness and parseMemoryCheckpointId. Flag-off path verifies
 * stableCount=null, topStable=[] when MEGACOMPACT_MEMORY_STABILITY is off.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addMemory } from "./store/sqlite/memories.js";
import { closeStore, openStore } from "./store/sqlite/utils.js";
import { openTurnStore, closeAllTurnDbs } from "./store/turns/connection.js";
import { readMemoryEffectiveness, parseMemoryCheckpointId } from "./memoryStats.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-memstats-"));
	delete process.env.MEGACOMPACT_MEMORY_STABILITY;
});

afterEach(() => {
	closeAllTurnDbs();
	try { closeStore(tmpDir); } catch { /* ok */ }
	rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.MEGACOMPACT_MEMORY_STABILITY;
});

function seedTurnAndRecall(
	stateDir: string,
	turnIndex: number,
	endedDaysAgo: number,
	memoryId: number,
	score: number,
): void {
	const db = openTurnStore(stateDir);
	const endedAt = Date.now() - endedDaysAgo * 86_400_000;
	db.prepare(
		`INSERT INTO turns(conversation_id, session_id, turn_index, role, ended_at)
		 VALUES(?, ?, ?, 'user', ?)`,
	).run("conv-s53", "sess-s53", turnIndex, endedAt);
	const turnId = Number(
		(db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
	);
	db.prepare(
		`INSERT INTO turn_recall(turn_id, checkpoint_id, score, source)
		 VALUES(?, ?, ?, 'memory')`,
	).run(turnId, `memory#${memoryId}`, score);
}

describe("memoryStats (S53B)", () => {
	it("returns zeroed aggregates when no memories exist", () => {
		const eff = readMemoryEffectiveness(null, tmpDir);
		assert.equal(eff.totalMemories, 0);
		assert.equal(eff.neverReferenced, 0);
		assert.equal(eff.recallEvents30d, 0);
		assert.equal(eff.stableCount, 0);
		assert.deepEqual(eff.topStable, []);
	});

	it("counts never-referenced correctly (no last_referenced, no turn_recall)", () => {
		addMemory({ content: "unreferenced memory" }, null, tmpDir);
		addMemory({ content: "another one" }, null, tmpDir);
		const eff = readMemoryEffectiveness(null, tmpDir);
		assert.equal(eff.totalMemories, 2);
		assert.equal(eff.neverReferenced, 2);
	});

	it("computes recall events + distinct memories from turn_recall", () => {
		const id1 = addMemory({ content: "memory A" }, null, tmpDir);
		const id2 = addMemory({ content: "memory B" }, null, tmpDir);
		// Two recall events for memory#1, one for memory#2 (all within 30d).
		seedTurnAndRecall(tmpDir, 0, 1, id1, 0.7);
		seedTurnAndRecall(tmpDir, 1, 1, id1, 0.5);
		seedTurnAndRecall(tmpDir, 2, 1, id2, 0.6);
		const eff = readMemoryEffectiveness(null, tmpDir);
		assert.equal(eff.recallEvents30d, 3);
		assert.equal(eff.distinctRecalled30d, 2);
		// avgScore = (0.7 + 0.5 + 0.6) / 3 = 0.6
		assert.ok(eff.avgRecallScore != null);
		assert.ok(Math.abs(eff.avgRecallScore! - 0.6) < 0.001);
	});

	it("ignores turn_recall events older than 30 days", () => {
		const id1 = addMemory({ content: "old recall" }, null, tmpDir);
		seedTurnAndRecall(tmpDir, 0, 31, id1, 0.9); // 31 days ago — outside window
		const eff = readMemoryEffectiveness(null, tmpDir);
		assert.equal(eff.recallEvents30d, 0);
		assert.equal(eff.distinctRecalled30d, 0);
		assert.equal(eff.avgRecallScore, null);
	});

	it("computes stability blend + stableCount (flag ON by default)", () => {
		const id1 = addMemory({ content: "stable memory" }, null, tmpDir);
		addMemory({ content: "never recalled" }, null, tmpDir);
		// 6 recall events for memory#1, all recent → high stability.
		for (let i = 0; i < 6; i++) {
			seedTurnAndRecall(tmpDir, i, 1, id1, 0.5);
		}
		// Manually set last_referenced to now.
		const store = openStore(tmpDir);
		store.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?")
			.run(Math.floor(Date.now() / 1000), id1);
		const eff = readMemoryEffectiveness(null, tmpDir);
		assert.equal(eff.stabilityEnabled, true);
		assert.ok(eff.stableCount != null && eff.stableCount >= 1, "memory with 6 events should be stable");
		assert.ok(eff.topStable.length >= 1);
		assert.equal(eff.topStable[0].id, id1);
		// stability ≈ 0.5*0.6 + 0.3*1.0 + 0.2*0.5 = 0.70
		assert.ok(eff.topStable[0].stability >= 0.6);
	});

	it("MEGACOMPACT_MEMORY_STABILITY=0 disables stability (null stable, empty topStable)", () => {
		process.env.MEGACOMPACT_MEMORY_STABILITY = "0";
		addMemory({ content: "no stability" }, null, tmpDir);
		const eff = readMemoryEffectiveness(null, tmpDir);
		assert.equal(eff.stabilityEnabled, false);
		assert.equal(eff.stableCount, null);
		assert.deepEqual(eff.topStable, []);
	});

	it("parseMemoryCheckpointId extracts the memory id", () => {
		assert.equal(parseMemoryCheckpointId("memory#42"), 42);
		assert.equal(parseMemoryCheckpointId("memory#0"), 0);
		assert.equal(parseMemoryCheckpointId("checkpoint-abc"), null);
		assert.equal(parseMemoryCheckpointId(""), null);
	});
});
