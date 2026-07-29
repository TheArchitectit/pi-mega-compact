/**
 * memory-store.test.ts — InMemoryTurnStore compliance.
 */

import { InMemoryTurnStore } from "./memory-store.js";
import { runComplianceSuite } from "./contract-compliance.test.js";

// Run the shared compliance suite against the in-memory backend
runComplianceSuite("InMemoryTurnStore", (options) => {
	return new InMemoryTurnStore(options);
}, { stateDir: "/tmp/turns-compliance-memory", inMemory: true });
