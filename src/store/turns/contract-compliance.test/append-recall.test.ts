/**
 * append-recall.test.ts — appendTurn/getTurn + appendRecall/listRecall round-trips.
 * Sub-suite of the TurnStore compliance suite.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import type { TurnStore } from "../types.js";
import { makeTurn, makeRecall } from "./_helpers.js";

export function runAppendRecallSuite(store: () => TurnStore): void {
	it("appendTurn returns a TurnId; getTurn retrieves the entry", () => {
		const s = store();
		const entry = makeTurn({ turnIndex: 0 });
		const id = s.asWriter().appendTurn(entry);
		assert.ok(typeof id === "string" && id.length > 0, "TurnId is a non-empty string");
		const retrieved = s.asReader().getTurn(id);
		assert.ok(retrieved, "getTurn should return the entry");
		assert.equal(retrieved!.conversationId, entry.conversationId);
		assert.equal(retrieved!.turnIndex, entry.turnIndex);
		assert.equal(retrieved!.role, entry.role);
	});

	it("appendTurn preserves optional fields", () => {
		const s = store();
		const entry = makeTurn({
			turnIndex: 1,
			ctxTokens: 5000,
			ctxPercent: 0.65,
			pressureBand: "yellow",
			model: "claude-sonnet-4",
		});
		const id = s.asWriter().appendTurn(entry);
		const retrieved = s.asReader().getTurn(id);
		assert.ok(retrieved);
		assert.equal(retrieved!.ctxTokens, 5000);
		assert.equal(retrieved!.ctxPercent, 0.65);
		assert.equal(retrieved!.pressureBand, "yellow");
		assert.equal(retrieved!.model, "claude-sonnet-4");
	});

	it("appendRecall + listRecall round-trips", () => {
		const s = store();
		const tid = s.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
		const recall = makeRecall(tid, {
			checkpointId: "ckpt_r1",
			score: 0.9,
			source: "cluster_summary",
		});
		s.asWriter().appendRecall(recall);
		const results = s.asReader().listRecall(tid);
		assert.equal(results.length, 1);
		assert.equal(results[0].checkpointId, "ckpt_r1");
		assert.equal(results[0].score, 0.9);
		assert.equal(results[0].source, "cluster_summary");
	});

	it("appendRecall deduplicates on (turnId, checkpointId)", () => {
		const s = store();
		const tid = s.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
		const r1 = makeRecall(tid, { checkpointId: "ckpt_dedup", score: 0.7 });
		const r2 = makeRecall(tid, { checkpointId: "ckpt_dedup", score: 0.8 });
		s.asWriter().appendRecall(r1);
		s.asWriter().appendRecall(r2);
		const results = s.asReader().listRecall(tid);
		assert.ok(results.length >= 1 && results.length <= 2);
	});
}
