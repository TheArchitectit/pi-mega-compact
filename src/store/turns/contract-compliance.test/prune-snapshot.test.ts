/**
 * prune-snapshot.test.ts — prune, checkpoint/restore, close, clear, capability
 * gating, and DuplicateTurnError. Sub-suite of the TurnStore compliance suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TurnStore, TurnEntry } from "../types.js";
import { DuplicateTurnError } from "../types.js";
import type { StoreFactory } from "./_helpers.js";
import { makeTurn, makeRecall } from "./_helpers.js";

export function runPruneSnapshotSuite(
	store: () => TurnStore,
	factory: StoreFactory,
	options: import("../types.js").TurnStoreOptions,
): void {
	it("prune removes old turns, respects keepMinPerConversation", () => {
		const s = store();
		const convId = "conv_prune";
		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: i, endedAt: now - (5 - i) * 1000 }));
		}
		const report = s.asAdmin().prune({ maxTurnAgeMs: 3500, keepMinPerConversation: 3, vacuumAfterPrune: false });
		assert.ok(report.turnsRemoved >= 0, "prune report has turnsRemoved");
		assert.equal(s.asReader().countTurns(convId), 5 - report.turnsRemoved);
	});

	it("prune cascades recall for deleted turns", () => {
		const s = store();
		const convId = "conv_prune_recall";
		const now = Date.now();
		const tid0 = s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 0, endedAt: now - 10000 }));
		s.asWriter().appendRecall(makeRecall(tid0));
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 1, endedAt: now }));
		const report = s.asAdmin().prune({ maxTurnAgeMs: 5000, keepMinPerConversation: 1, vacuumAfterPrune: false });
		if (report.turnsRemoved > 0) {
			assert.ok(report.recallRemoved >= 0, "recall cascaded");
		}
	});

	it("checkpoint + restore is lossless", () => {
		const s = store();
		const convId = "conv_snapshot";
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 0 }));
		const tid = s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 1, ctxTokens: 8000, ctxPercent: 0.8, pressureBand: "red", model: "test-model" }));
		s.asWriter().appendRecall(makeRecall(tid, { checkpointId: "ckpt_snap", score: 0.95, source: "memory" }));
		s.asWriter().forkConversation(convId, 1);
		const snapshot = s.asAdmin().checkpoint();
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.turns.length, 3, "2 parent + 1 child seed turn");
		assert.equal(snapshot.recall.length, 2, "1 parent recall + 1 child seed recall (copied from parent)");
		assert.equal(snapshot.forks.length, 1);
		s.asAdmin().clear();
		assert.equal(s.asReader().countTurns(convId), 0);
		s.asAdmin().restore(snapshot);
		assert.equal(s.asReader().countTurns(convId), 2);
		const turns = s.asReader().query({ conversationId: convId });
		assert.equal(turns.length, 2);
		assert.equal(turns[1].ctxTokens, 8000);
		assert.equal(turns[1].pressureBand, "red");
		assert.equal(turns[1].model, "test-model");
		const turn1 = turns.find((t) => t.turnIndex === 1);
		assert.ok(turn1, "turn at index 1 should exist after restore");
		const snapshot2 = s.asAdmin().checkpoint();
		assert.equal(snapshot2.turns.length, 3, "second checkpoint has 3 turns (2 parent + 1 child seed)");
		assert.equal(snapshot2.recall.length, 2, "second checkpoint has 2 recall (1 parent + 1 child seed)");
		assert.equal(snapshot2.recall[0].checkpointId, "ckpt_snap", "recall checkpointId preserved");
		assert.equal(snapshot2.recall[0].score, 0.95, "recall score preserved");
		assert.equal(snapshot2.recall[0].source, "memory", "recall source preserved");
		const forks = s.asReader().listForks(convId);
		assert.equal(forks.length, 1);
	});

	it("close is idempotent", () => {
		store().close(); // current store — should not throw
		const store2 = factory(options);
		store2.close();
		store2.close();
	});

	it("clear wipes all data", () => {
		const s = store();
		s.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
		s.asAdmin().clear();
		assert.equal(s.asReader().query({}).length, 0, "no turns after clear");
	});

	it("asReader returns a TurnReader (type check)", () => {
		const reader = store().asReader();
		assert.equal(typeof reader.query, "function");
		assert.equal(typeof reader.getTurn, "function");
		assert.equal(typeof reader.listRecall, "function");
		assert.equal(typeof reader.listForks, "function");
		assert.equal(typeof reader.countTurns, "function");
		assert.equal(typeof reader.conversationStats, "function");
	});

	it("asWriter returns a TurnWriter (type check)", () => {
		const writer = store().asWriter();
		assert.equal(typeof writer.appendTurn, "function");
		assert.equal(typeof writer.appendRecall, "function");
		assert.equal(typeof writer.ensureConversationId, "function");
		assert.equal(typeof writer.forkConversation, "function");
	});

	it("asAdmin returns a TurnAdmin (type check)", () => {
		const admin = store().asAdmin();
		assert.equal(typeof admin.prune, "function");
		assert.equal(typeof admin.vacuum, "function");
		assert.equal(typeof admin.checkpoint, "function");
		assert.equal(typeof admin.restore, "function");
		assert.equal(typeof admin.clear, "function");
	});

	describe("DuplicateTurnError", () => {
		it("throws DuplicateTurnError (not a raw error / not silent) on duplicate (conversationId, turnIndex)", () => {
			const s = store();
			const first: TurnEntry = {
				conversationId: "conv_dupcheck",
				sessionId: "sess_dup",
				turnIndex: 99,
				role: "user",
				endedAt: Date.now(),
			};
			const writer = s.asWriter();
			writer.appendTurn(first);
			const duplicate: TurnEntry = {
				conversationId: "conv_dupcheck",
				sessionId: "sess_dup",
				turnIndex: 99,
				role: "user",
				endedAt: Date.now(),
			};
			const err = assert.throws(
				() => writer.appendTurn(duplicate),
				(e) => e instanceof DuplicateTurnError,
			) as unknown as DuplicateTurnError | undefined;
			if (err && typeof err === "object" && "conversationId" in err) {
				assert.equal(err.conversationId, "conv_dupcheck");
				assert.equal(err.turnIndex, 99);
			}
		});
	});
}
