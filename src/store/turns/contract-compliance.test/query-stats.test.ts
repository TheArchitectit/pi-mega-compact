/**
 * query-stats.test.ts — query filter composition + conversationStats aggregation.
 * Sub-suite of the TurnStore compliance suite.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import type { TurnStore } from "../types.js";
import { makeTurn } from "./_helpers.js";

export function runQueryStatsSuite(store: () => TurnStore): void {
	it("query with no filter returns all turns", () => {
		const s = store();
		s.asWriter().appendTurn(makeTurn({ turnIndex: 0 }));
		s.asWriter().appendTurn(makeTurn({ turnIndex: 1 }));
		const results = s.asReader().query({});
		assert.ok(results.length >= 2);
	});

	it("query filters by conversationId", () => {
		const s = store();
		s.asWriter().appendTurn(makeTurn({ conversationId: "conv_a", turnIndex: 0 }));
		s.asWriter().appendTurn(makeTurn({ conversationId: "conv_b", turnIndex: 0 }));
		const results = s.asReader().query({ conversationId: "conv_a" });
		assert.equal(results.length, 1);
		assert.equal(results[0].conversationId, "conv_a");
	});

	it("query filters by time range (sinceMs + untilMs)", () => {
		const s = store();
		const now = Date.now();
		s.asWriter().appendTurn(makeTurn({ turnIndex: 0, endedAt: now - 2000 }));
		s.asWriter().appendTurn(makeTurn({ turnIndex: 1, endedAt: now - 1000 }));
		s.asWriter().appendTurn(makeTurn({ turnIndex: 2, endedAt: now }));
		const results = s.asReader().query({ sinceMs: now - 1500, untilMs: now - 500 });
		assert.equal(results.length, 1);
		assert.equal(results[0].turnIndex, 1);
	});

	it("query filters by pressureBand", () => {
		const s = store();
		s.asWriter().appendTurn(makeTurn({ turnIndex: 0, pressureBand: "red" }));
		s.asWriter().appendTurn(makeTurn({ turnIndex: 1, pressureBand: "green" }));
		const results = s.asReader().query({ pressureBand: "red" });
		assert.equal(results.length, 1);
		assert.equal(results[0].pressureBand, "red");
	});

	it("query respects limit and offset", () => {
		const s = store();
		for (let i = 0; i < 5; i++) s.asWriter().appendTurn(makeTurn({ turnIndex: i }));
		const page1 = s.asReader().query({ limit: 2, offset: 0 });
		const page2 = s.asReader().query({ limit: 2, offset: 2 });
		assert.equal(page1.length, 2);
		assert.equal(page2.length, 2);
		assert.notEqual(page1[0].turnIndex, page2[0].turnIndex);
	});

	it("conversationStats aggregates correctly", () => {
		const s = store();
		const now = Date.now();
		const convId = "conv_stats";
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 0, endedAt: now - 2000, ctxPercent: 0.3, pressureBand: "green" }));
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 1, endedAt: now - 1000, ctxPercent: 0.7, pressureBand: "yellow" }));
		s.asWriter().appendTurn(makeTurn({ conversationId: convId, turnIndex: 2, endedAt: now, pressureBand: "green" }));
		const stats = s.asReader().conversationStats(convId);
		assert.equal(stats.turnCount, 3);
		assert.equal(stats.firstTurnAt, now - 2000);
		assert.equal(stats.lastTurnAt, now);
		assert.ok(Math.abs(stats.avgCtxPercent - 0.5) < 0.01);
		assert.equal(stats.pressureBands.green, 2);
		assert.equal(stats.pressureBands.yellow, 1);
	});

	it("conversationStats returns zeros for empty conversation", () => {
		const s = store();
		const stats = s.asReader().conversationStats("conv_nonexistent");
		assert.equal(stats.turnCount, 0);
		assert.equal(stats.avgCtxPercent, 0);
	});
}
