/**
 * memory-store.test.ts — InMemoryAnalyticsStore compliance + in-memory specifics.
 */
import { runComplianceSuite } from "./contract-compliance.test.js";
import { InMemoryAnalyticsStore } from "./memory-store.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

runComplianceSuite(
	"InMemoryAnalyticsStore",
	(options) => new InMemoryAnalyticsStore(options),
	{ stateDir: join(tmpdir(), "analytics-compliance-memory"), inMemory: true },
);
