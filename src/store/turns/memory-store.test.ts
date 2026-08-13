/**
 * memory-store.test.ts — InMemoryTurnStore compliance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTurnStore } from "./memory-store.js";
import { runComplianceSuite } from "./contract-compliance.test.js";

// Run the shared compliance suite against the in-memory backend
runComplianceSuite(
	"InMemoryTurnStore",
	(options) => {
		return new InMemoryTurnStore(options);
	},
	{ stateDir: "/tmp/turns-compliance-memory", inMemory: true },
);

// ── S49R: monotonic turn index + resume fix (InMemory backend) ──
describe("InMemoryTurnStore — S49R resume", () => {
	it("nextTurnIndexFor returns 0 for empty, MAX+1 with gaps", () => {
		const s = new InMemoryTurnStore({ stateDir: "/tmp/mc-r" });
		assert.equal(s.asReader().nextTurnIndexFor("c"), 0);
		for (const ti of [0, 1, 5]) {
			s.asWriter().appendTurn({
				conversationId: "c",
				sessionId: "s",
				turnIndex: ti,
				role: "assistant",
				endedAt: Date.now() + ti,
			});
		}
		assert.equal(s.asReader().nextTurnIndexFor("c"), 6);
	});

	it("resend of same sessionTurnIndex after a gap continues monotonically", () => {
		const s = new InMemoryTurnStore({ stateDir: "/tmp/mc-r2" });
		const c = "conv_resend";
		s.asWriter().appendTurn({
			conversationId: c,
			sessionId: "s",
			turnIndex: 0,
			sessionTurnIndex: 0,
			role: "assistant",
			endedAt: Date.now(),
		});
		s.asWriter().appendTurn({
			conversationId: c,
			sessionId: "s",
			turnIndex: 5,
			sessionTurnIndex: 5,
			role: "assistant",
			endedAt: Date.now() + 1,
		});
		const next = s.asReader().nextTurnIndexFor(c);
		assert.equal(next, 6);
		assert.doesNotThrow(() =>
			s.asWriter().appendTurn({
				conversationId: c,
				sessionId: "s",
				turnIndex: next,
				sessionTurnIndex: 0,
				role: "assistant",
				endedAt: Date.now() + 2,
			}),
		);
	});
});
