/**
 * _helpers.ts — shared fixtures for the TurnStore compliance suite.
 *
 * Extracted from contract-compliance.test.ts so the suite stays under the
 * 500-line hard limit. Backend test files (sqlite-store.test.ts,
 * memory-store.test.ts) import runComplianceSuite from the parent shell;
 * the sub-suite files import these helpers.
 */
import type { TurnEntry, TurnRecallEntry, TurnStore } from "../types.js";

/** Factory function — backend test files provide the concrete constructor. */
export type StoreFactory = (options: import("../types.js").TurnStoreOptions) => TurnStore;

/** Helper: create a valid TurnEntry. */
export function makeTurn(overrides: Partial<TurnEntry> = {}): TurnEntry {
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
export function makeRecall(
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
