/**
 * sqlite-store.test.ts — SqliteTurnStore compliance.
 */

import { SqliteTurnStore } from "./sqlite-store.js";
import { runComplianceSuite } from "./contract-compliance.test.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Run the shared compliance suite against SqliteTurnStore (in-memory mode)
runComplianceSuite(
	"SqliteTurnStore",
	(options) => new SqliteTurnStore(options),
	{ stateDir: join(tmpdir(), "turns-compliance-sqlite"), inMemory: true },
);
