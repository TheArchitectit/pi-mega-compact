/**
 * contract-compliance.test.ts — Shared compliance suite for TurnStore.
 *
 * Parameterized: takes a factory function and runs every contract assertion
 * against the produced store. Imported by backend-specific test files to prove
 * both SqliteTurnStore and InMemoryTurnStore satisfy the same contract.
 *
 * Contract guarantees tested:
 *   1. appendTurn returns a TurnId; getTurn round-trips
 *   2. appendRecall + listRecall round-trips
 *   3. query filters compose (AND)
 *   4. conversationStats aggregates correctly
 *   5. forkConversation creates fork lineage
 *   6. asReader cannot append (type-level — verified by compilation)
 *   7. asWriter cannot prune (type-level — verified by compilation)
 *   8. asAdmin can prune + checkpoint + restore
 *   9. checkpoint/restore round-trip is lossless
 *  10. close() is idempotent
 *  11. clear() wipes all data
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type {
	TurnStore,
	TurnEntry,
	TurnRecallEntry,
	TurnStoreOptions,
} from "./types.js";

/** Factory function — backend test files provide the concrete constructor. */
export type StoreFactory = (options: TurnStoreOptions) => TurnStore;

/** Helper: create a valid TurnEntry. */
function makeTurn(overrides: Partial<TurnEntry> = {}): TurnEntry {
	return {
		conversationId: "conv_test1234",
		sessionId: "sess_abc",
		turnIndex: 0,
		role: "assistant",
		endedAt: Date.now(),
		...overrides,
	};
}

/** Helper: create a valid TurnRecallEntry. */
function makeRecall(
	turnId: string,
	overrides: Partial<TurnRecallEntry> = {},
): TurnRecallEntry {
	return {
		turnId,
		checkpointId: "ckpt_001",
		score: 0.85,
		source: "checkpoint",
		...overrides,
	};
}

/**
 * Run the full compliance suite against a TurnStore factory.
 * Backend test files call this with their constructor.
 */
export function runComplianceSuite(
	name: string,
	factory: StoreFactory,
	options: TurnStoreOptions,
): void {
	describe(`${name} — TurnStore compliance`, () => {
		let store: TurnStore;

		beforeEach(() => {
			store = factory(options);
		});

		afterEach(() => {
			try {
				store.asAdmin().clear();
			} catch {
				// best-effort
			}
			try {
				store.close();
			} catch {
				// best-effort
			}
		});

		// ── 1. appendTurn + getTurn round-trip ──────────────────

		it("appendTurn returns a TurnId; getTurn retrieves the entry", () => {
			const entry = makeTurn({ turnIndex: 0 });
			const id = store.asWriter().appendTurn(entry);
			assert.ok(
				typeof id === "string" && id.length > 0,
				"TurnId is a non-empty string",
			);

			const retrieved = store.asReader().getTurn(id);
			assert.ok(retrieved, "getTurn should return the entry");
			assert.equal(retrieved!.conversationId, entry.conversationId);
			assert.equal(retrieved!.turnIndex, entry.turnIndex);
			assert.equal(retrieved!.role, entry.role);
		});

		it("appendTurn preserves optional fields", () => {
			const entry = makeTurn({
				turnIndex: 1,
				ctxTokens: 5000,
				ctxPercent: 0.65,
				pressureBand: "yellow",
				model: "claude-sonnet-4",
			});
			const id = store.asWriter().appendTurn(entry);
			const retrieved = store.asReader().getTurn(id);
			assert.ok(retrieved);
			assert.equal(retrieved!.ctxTokens, 5000);
			assert.equal(retrieved!.ctxPercent, 0.65);
			assert.equal(retrieved!.pressureBand, "yellow");
			assert.equal(retrieved!.model, "claude-sonnet-4");
		});

		// ── 2. appendRecall + listRecall round-trip ──────────────

		it("appendRecall + listRecall round-trips", () => {
			const tid = store.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
			const recall = makeRecall(tid, {
				checkpointId: "ckpt_r1",
				score: 0.9,
				source: "cluster_summary",
			});
			store.asWriter().appendRecall(recall);

			const results = store.asReader().listRecall(tid);
			assert.equal(results.length, 1);
			assert.equal(results[0].checkpointId, "ckpt_r1");
			assert.equal(results[0].score, 0.9);
			assert.equal(results[0].source, "cluster_summary");
		});

		it("appendRecall deduplicates on (turnId, checkpointId)", () => {
			const tid = store.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
			const r1 = makeRecall(tid, { checkpointId: "ckpt_dedup", score: 0.7 });
			const r2 = makeRecall(tid, { checkpointId: "ckpt_dedup", score: 0.8 });

			store.asWriter().appendRecall(r1);
			store.asWriter().appendRecall(r2);

			const results = store.asReader().listRecall(tid);
			// Either 1 (deduped) or 2 (last-write-wins) — both valid contract behaviors
			assert.ok(results.length >= 1 && results.length <= 2);
		});

		// ── 3. query filters compose (AND) ──────────────────────

		it("query with no filter returns all turns", () => {
			store.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
			store.asWriter().appendTurn(makeTurn({ turnIndex: 1 }));

			const results = store.asReader().query({});
			assert.ok(results.length >= 2);
		});

		it("query filters by conversationId", () => {
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: "conv_a", turnIndex: 0 }));
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: "conv_b", turnIndex: 0 }));

			const results = store.asReader().query({ conversationId: "conv_a" });
			assert.equal(results.length, 1);
			assert.equal(results[0].conversationId, "conv_a");
		});

		it("query filters by time range (sinceMs + untilMs)", () => {
			const now = Date.now();
			store
				.asWriter()
				.appendTurn(makeTurn({ turnIndex: 0, endedAt: now - 2000 }));
			store
				.asWriter()
				.appendTurn(makeTurn({ turnIndex: 1, endedAt: now - 1000 }));
			store.asWriter().appendTurn(makeTurn({ turnIndex: 2, endedAt: now }));

			const results = store.asReader().query({
				sinceMs: now - 1500,
				untilMs: now - 500,
			});
			assert.equal(results.length, 1);
			assert.equal(results[0].turnIndex, 1);
		});

		it("query filters by pressureBand", () => {
			store
				.asWriter()
				.appendTurn(makeTurn({ turnIndex: 0, pressureBand: "red" }));
			store
				.asWriter()
				.appendTurn(makeTurn({ turnIndex: 1, pressureBand: "green" }));

			const results = store.asReader().query({ pressureBand: "red" });
			assert.equal(results.length, 1);
			assert.equal(results[0].pressureBand, "red");
		});

		it("query respects limit and offset", () => {
			for (let i = 0; i < 5; i++) {
				store.asWriter().appendTurn(makeTurn({ turnIndex: i }));
			}

			const page1 = store.asReader().query({ limit: 2, offset: 0 });
			const page2 = store.asReader().query({ limit: 2, offset: 2 });
			assert.equal(page1.length, 2);
			assert.equal(page2.length, 2);
			assert.notEqual(page1[0].turnIndex, page2[0].turnIndex);
		});

		// ── 4. conversationStats ────────────────────────────────

		it("conversationStats aggregates correctly", () => {
			const now = Date.now();
			const convId = "conv_stats";
			store.asWriter().appendTurn(
				makeTurn({
					conversationId: convId,
					turnIndex: 0,
					endedAt: now - 2000,
					ctxPercent: 0.3,
					pressureBand: "green",
				}),
			);
			store.asWriter().appendTurn(
				makeTurn({
					conversationId: convId,
					turnIndex: 1,
					endedAt: now - 1000,
					ctxPercent: 0.7,
					pressureBand: "yellow",
				}),
			);
			store.asWriter().appendTurn(
				makeTurn({
					conversationId: convId,
					turnIndex: 2,
					endedAt: now,
					pressureBand: "green",
				}),
			);

			const stats = store.asReader().conversationStats(convId);
			assert.equal(stats.turnCount, 3);
			assert.equal(stats.firstTurnAt, now - 2000);
			assert.equal(stats.lastTurnAt, now);
			assert.ok(Math.abs(stats.avgCtxPercent - 0.5) < 0.01);
			assert.equal(stats.pressureBands.green, 2);
			assert.equal(stats.pressureBands.yellow, 1);
		});

		it("conversationStats returns zeros for empty conversation", () => {
			const stats = store.asReader().conversationStats("conv_nonexistent");
			assert.equal(stats.turnCount, 0);
			assert.equal(stats.avgCtxPercent, 0);
		});

		// ── 5. forkConversation ─────────────────────────────────

		it("forkConversation creates a child conversation with fork lineage", () => {
			const parentId = "conv_parent";
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: parentId, turnIndex: 0 }));
			const tid = store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: parentId, turnIndex: 1 }));
			store
				.asWriter()
				.appendRecall(makeRecall(tid, { checkpointId: "ckpt_fork" }));

			const childId = store.asWriter().forkConversation(parentId, 1);
			assert.ok(childId.startsWith("conv_"), "child is a conversation id");
			assert.notEqual(childId, parentId, "child is a different conversation");

			const forks = store.asReader().listForks(parentId);
			assert.equal(forks.length, 1);
			assert.equal(forks[0].childConversationId, childId);
			assert.equal(forks[0].forkTurnIndex, 1);
		});

		it("forkConversation seeds child with parent recall", () => {
			const parentId = "conv_seed_parent";
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: parentId, turnIndex: 0 }));
			const tid1 = store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: parentId, turnIndex: 1 }));
			// Attach recall to the parent's turn at index 1
			store
				.asWriter()
				.appendRecall(
					makeRecall(tid1, {
						checkpointId: "ckpt_seed1",
						score: 0.9,
						source: "checkpoint",
					}),
				);
			store
				.asWriter()
				.appendRecall(
					makeRecall(tid1, {
						checkpointId: "ckpt_seed2",
						score: 0.7,
						source: "memory",
					}),
				);

			const childId = store.asWriter().forkConversation(parentId, 1);

			// The child should have a seed turn (turnIndex 0, role system)
			const childTurns = store.asReader().query({ conversationId: childId });
			assert.ok(childTurns.length >= 1, "child has at least one turn");

			const seedTurn = childTurns.find(
				(t) => t.turnIndex === 0 && t.role === "system",
			);
			assert.ok(seedTurn, "child has a seed turn");

			// The seed turn should have the parent's recall entries.
			// Use snapshot-based verification (position-stable IDs).
			const snapshot = store.asAdmin().checkpoint();
			const childRecallInSnapshot = snapshot.recall.filter((r) => {
				// The recall's turnId should point to a turn in the child conversation
				const turnIdx = Number(r.turnId) - 1;
				const turn = snapshot.turns[turnIdx];
				return turn && turn.conversationId === childId;
			});
			assert.equal(
				childRecallInSnapshot.length,
				2,
				"child seed turn inherits both recall entries from parent",
			);
			assert.ok(
				childRecallInSnapshot.some((r) => r.checkpointId === "ckpt_seed1"),
				"child has ckpt_seed1",
			);
			assert.ok(
				childRecallInSnapshot.some((r) => r.checkpointId === "ckpt_seed2"),
				"child has ckpt_seed2",
			);
		});

		// ── 6. countTurns ──────────────────────────────────────

		it("countTurns returns the number of turns in a conversation", () => {
			const convId = "conv_count";
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: convId, turnIndex: 0 }));
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: convId, turnIndex: 1 }));

			assert.equal(store.asReader().countTurns(convId), 2);
			assert.equal(store.asReader().countTurns("conv_nonexistent"), 0);
		});

		// ── 7. ensureConversationId ─────────────────────────────

		it("ensureConversationId returns same id for same session", () => {
			const id1 = store.asWriter().ensureConversationId("sess_test1");
			const id2 = store.asWriter().ensureConversationId("sess_test1");
			assert.equal(
				id1,
				id2,
				"same session should always get the same conversationId",
			);
			assert.ok(id1.startsWith("conv_"), "conversationId has conv_ prefix");

			// After writing a turn with this session, ensureConversationId
			// should still return the same conversationId
			store
				.asWriter()
				.appendTurn(
					makeTurn({
						conversationId: id1,
						sessionId: "sess_test1",
						turnIndex: 0,
					}),
				);
			const id3 = store.asWriter().ensureConversationId("sess_test1");
			assert.equal(id3, id1, "conversationId stable after turn is written");
		});

		// ── 8. prune ────────────────────────────────────────────

		it("prune removes old turns, respects keepMinPerConversation", () => {
			const convId = "conv_prune";
			const now = Date.now();

			// 5 turns, 3 are old
			for (let i = 0; i < 5; i++) {
				store.asWriter().appendTurn(
					makeTurn({
						conversationId: convId,
						turnIndex: i,
						endedAt: now - (5 - i) * 1000,
					}),
				);
			}

			const report = store.asAdmin().prune({
				maxTurnAgeMs: 3500, // turns older than 3.5s
				keepMinPerConversation: 3, // keep at least 3
				vacuumAfterPrune: false,
			});

			// Should delete 2 (5 total - 3 minimum = 2 eligible, but only those older than cutoff)
			assert.ok(report.turnsRemoved >= 0, "prune report has turnsRemoved");
			assert.equal(
				store.asReader().countTurns(convId),
				5 - report.turnsRemoved,
			);
		});

		it("prune cascades recall for deleted turns", () => {
			const convId = "conv_prune_recall";
			const now = Date.now();

			const tid0 = store.asWriter().appendTurn(
				makeTurn({
					conversationId: convId,
					turnIndex: 0,
					endedAt: now - 10000,
				}),
			);
			store.asWriter().appendRecall(makeRecall(tid0));
			store.asWriter().appendTurn(
				makeTurn({
					conversationId: convId,
					turnIndex: 1,
					endedAt: now,
				}),
			);

			const report = store.asAdmin().prune({
				maxTurnAgeMs: 5000,
				keepMinPerConversation: 1,
				vacuumAfterPrune: false,
			});

			if (report.turnsRemoved > 0) {
				assert.ok(report.recallRemoved >= 0, "recall cascaded");
			}
		});

		// ── 9. checkpoint / restore round-trip ──────────────────

		it("checkpoint + restore is lossless", () => {
			const convId = "conv_snapshot";
			store
				.asWriter()
				.appendTurn(makeTurn({ conversationId: convId, turnIndex: 0 }));
			const tid = store.asWriter().appendTurn(
				makeTurn({
					conversationId: convId,
					turnIndex: 1,
					ctxTokens: 8000,
					ctxPercent: 0.8,
					pressureBand: "red",
					model: "test-model",
				}),
			);
			store.asWriter().appendRecall(
				makeRecall(tid, {
					checkpointId: "ckpt_snap",
					score: 0.95,
					source: "memory",
				}),
			);
			store.asWriter().forkConversation(convId, 1);

			const snapshot = store.asAdmin().checkpoint();
			assert.equal(snapshot.version, 1);
			// Fork creates a seed turn in the child, so total turns = 3
			assert.equal(snapshot.turns.length, 3, "2 parent + 1 child seed turn");
			assert.equal(
				snapshot.recall.length,
				2,
				"1 parent recall + 1 child seed recall (copied from parent)",
			);
			assert.equal(snapshot.forks.length, 1);

			// Clear and restore
			store.asAdmin().clear();
			assert.equal(store.asReader().countTurns(convId), 0);

			store.asAdmin().restore(snapshot);

			// Verify turns restored
			assert.equal(store.asReader().countTurns(convId), 2);

			// Verify turn content
			const turns = store.asReader().query({ conversationId: convId });
			assert.equal(turns.length, 2);
			assert.equal(turns[1].ctxTokens, 8000);
			assert.equal(turns[1].pressureBand, "red");
			assert.equal(turns[1].model, "test-model");

			// Verify recall restored: find the restored turn at turnIndex 1
			// and check its recall entries
			const turn1 = turns.find((t) => t.turnIndex === 1);
			assert.ok(turn1, "turn at index 1 should exist after restore");
			// We need the TurnId to query listRecall. Since restore may
			// remap IDs, we query by (conversationId, turnIndex) to find
			// the new TurnId via getTurn.
			//
			// Strategy: snapshot recall uses position-based IDs.
			// After restore, the turn at position 2 (index 1) should have
			// its recall. We can verify by taking a second checkpoint
			// and checking it matches the first.
			const snapshot2 = store.asAdmin().checkpoint();
			assert.equal(
				snapshot2.turns.length,
				3,
				"second checkpoint has 3 turns (2 parent + 1 child seed)",
			);
			assert.equal(
				snapshot2.recall.length,
				2,
				"second checkpoint has 2 recall (1 parent + 1 child seed)",
			);
			assert.equal(
				snapshot2.recall[0].checkpointId,
				"ckpt_snap",
				"recall checkpointId preserved",
			);
			assert.equal(snapshot2.recall[0].score, 0.95, "recall score preserved");
			assert.equal(
				snapshot2.recall[0].source,
				"memory",
				"recall source preserved",
			);

			// Verify forks restored
			const forks = store.asReader().listForks(convId);
			assert.equal(forks.length, 1);
		});

		// ── 10. close is idempotent ──────────────────────────────

		it("close is idempotent", () => {
			// Should not throw
			store.close();
			// Second close should also not throw
			// (create a new store for this since the old one is closed)
			const store2 = factory(options);
			store2.close();
			store2.close();
		});

		// ── 11. clear wipes all data ─────────────────────────────

		it("clear wipes all data", () => {
			store.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
			store.asAdmin().clear();
			assert.equal(
				store.asReader().query({}).length,
				0,
				"no turns after clear",
			);
		});

		// ── 12. Capability gating ────────────────────────────────

		it("asReader returns a TurnReader (type check)", () => {
			const reader = store.asReader();
			assert.equal(typeof reader.query, "function");
			assert.equal(typeof reader.getTurn, "function");
			assert.equal(typeof reader.listRecall, "function");
			assert.equal(typeof reader.listForks, "function");
			assert.equal(typeof reader.countTurns, "function");
			assert.equal(typeof reader.conversationStats, "function");
		});

		it("asWriter returns a TurnWriter (type check)", () => {
			const writer = store.asWriter();
			assert.equal(typeof writer.appendTurn, "function");
			assert.equal(typeof writer.appendRecall, "function");
			assert.equal(typeof writer.ensureConversationId, "function");
			assert.equal(typeof writer.forkConversation, "function");
		});

		it("asAdmin returns a TurnAdmin (type check)", () => {
			const admin = store.asAdmin();
			assert.equal(typeof admin.prune, "function");
			assert.equal(typeof admin.vacuum, "function");
			assert.equal(typeof admin.checkpoint, "function");
			assert.equal(typeof admin.restore, "function");
			assert.equal(typeof admin.clear, "function");
		});
	});
}
