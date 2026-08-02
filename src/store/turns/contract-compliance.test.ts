/**
 * contract-compliance.test.ts — Shared compliance suite for TurnStore (shell).
 *
 * Thin pointer that re-exports runComplianceSuite. The suite body is split
 * across ./contract-compliance.test/*.ts so no single file crosses the
 * 500-line hard limit (delegate-shell pattern). Backend test files import
 * runComplianceSuite from here — the path is unchanged:
 *   import { runComplianceSuite } from "./contract-compliance.test.js";
 *
 * Contract guarantees tested (see sub-suite files for the assertions):
 *   1. appendTurn/getTurn + 2. appendRecall/listRecall  — append-recall.test.ts
 *   3. query filters + 4. conversationStats              — query-stats.test.ts
 *   5. forkConversation + 6. countTurns + 7. ensureId    — fork-count.test.ts
 *   8. prune + 9. checkpoint/restore + 10. close +
 *   11. clear + 12. capability gating + dup detection   — prune-snapshot.test.ts
 */
import { describe, beforeEach, afterEach } from "node:test";
import type { TurnStore, TurnStoreOptions } from "./types.js";
import type { StoreFactory } from "./contract-compliance.test/_helpers.js";
import { runAppendRecallSuite } from "./contract-compliance.test/append-recall.test.js";
import { runQueryStatsSuite } from "./contract-compliance.test/query-stats.test.js";
import { runForkCountSuite } from "./contract-compliance.test/fork-count.test.js";
import { runPruneSnapshotSuite } from "./contract-compliance.test/prune-snapshot.test.js";

export type { StoreFactory } from "./contract-compliance.test/_helpers.js";

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
		const getStore = () => store;

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

		runAppendRecallSuite(getStore);
		runQueryStatsSuite(getStore);
		runForkCountSuite(getStore);
		runPruneSnapshotSuite(getStore, factory, options);
	});
}
