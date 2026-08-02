/**
 * fork-count.test.ts — forkConversation lineage + countTurns + ensureConversationId.
 * Sub-suite of the TurnStore compliance suite.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import type { TurnStore } from "../types.js";
import { makeTurn, makeRecall } from "./_helpers.js";

export function runForkCountSuite(store: () => TurnStore): void {
	it("forkConversation creates a child conversation with fork lineage", () => {
		const s = store();
		const parentId = "conv_parent";
		s.asWriter().appendTurn(makeTurn({ conversationId: parentId, turnIndex: 0 }));
		const tid = s.asWriter().appendTurn(makeTurn({ conversationId: parentId, turnIndex: 1 }));
		s.asWriter().appendRecall(makeRecall(tid, { checkpointId: "ckpt_fork" }));
		const childId = s.asWriter().forkConversation(parentId, 1);
		assert.ok(childId.startsWith("conv_"), "child is a conversation id");
		assert.notEqual(childId, parentId, "child is a different conversation");
		const forks = s.asReader().listForks(parentId);
		assert.equal(forks.length, 1);
		assert.equal(forks[0].childConversationId, childId);
		assert.equal(forks[0].forkTurnIndex, 1);
	});

	it("forkConversation seeds child with parent recall", () => {
		const s = store();
		const parentId = "conv_seed_parent";
		s.asWriter().appendTurn(makeTurn({ conversationId: parentId, turnIndex: 0 }));
		const tid1 = s.asWriter().appendTurn(makeTurn({ conversationId: parentId, turnIndex: 1 }));
		s.asWriter().appendRecall(makeRecall(tid1, { checkpointId: "ckpt_seed1", score: 0.9, source: "checkpoint" }));
		s.asWriter().appendRecall(makeRecall(tid1, { checkpointId: "ckpt_seed2", score: 0.7, source: "memory" }));
		const childId = s.asWriter().forkConversation(parentId, 1);
		const childTurns = s.asReader().query({ conversationId: childId });
		assert.ok(childTurns.length >= 1, "child has at least one turn");
		const seedTurn = childTurns.find((t) => t.turnIndex === 0 && t.role === "system");
		assert.ok(seedTurn, "child has a seed turn");
		const snapshot = s.asAdmin().checkpoint();
		const childRecallInSnapshot = snapshot.recall.filter((r) => {
			const turnIdx = Number(r.turnId) - 1;
			const turn = snapshot.turns[turnIdx];
			return turn && turn.conversationId === childId;
		});
		assert.equal(childRecallInSnapshot.length, 2, "child seed turn inherits both recall entries from parent");
		assert.ok(childRecallInSnapshot.some((r) => r.checkpointId === "ckpt_seed1"), "child has ckpt_seed1");
		assert.ok(childRecallInSnapshot.some((r) => r.checkpointId === "ckpt_seed2"), "child has ckpt_seed2");
	});

	it("countTurns returns the number of turns in a conversation", () => {
		const s = store();
		const convId = "conv_count";
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 0 }));
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 1 }));
		assert.equal(s.asReader().countTurns(convId), 2);
		assert.equal(s.asReader().countTurns("conv_nonexistent"), 0);
	});

	it("ensureConversationId returns same id for same session", () => {
		const s = store();
		const id1 = s.asWriter().ensureConversationId("sess_test1");
		const id2 = s.asWriter().ensureConversationId("sess_test1");
		assert.equal(id1, id2, "same session should always get the same conversationId");
		assert.ok(id1.startsWith("conv_"), "conversationId has conv_ prefix");
		s.asWriter().appendTurn(makeTurn({ conversationId: id1, sessionId: "sess_test1", turnIndex: 0 }));
		const id3 = s.asWriter().ensureConversationId("sess_test1");
		assert.equal(id3, id1, "conversationId stable after turn is written");
	});
}
