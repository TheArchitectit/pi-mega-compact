/**
 * index.ts — Barrel for src/store/analytics/ (PMA-1).
 *
 * Hosts import types + the factory. SQL schemas + internals stay private.
 *
 * PREVENT-PI-004: no network. PREVENT-002: parameterized SQL only.
 */

export type {
	RequestEventKind,
	FactSource,
	QualityNote,
	RequestEventFact,
	MeasurementFact,
	IdentityObservation,
	AppendResult,
	AnalyticsStatus,
	AnalyticsEventFilter,
	AnalyticsEventPage,
	PruneReport,
	IntegrityReport,
	MaintenanceReport,
	BackupReport,
	RetentionPolicy,
	AnalyticsReader,
	AnalyticsWriter,
	AnalyticsAdmin,
	AnalyticsStore,
	AnalyticsStoreOptions,
	AnalyticsStoreFactory,
} from "./types.js";

export { SqliteAnalyticsStore } from "./sqlite-store.js";
export { InMemoryAnalyticsStore } from "./memory-store.js";

export {
	openAnalyticsDb,
	closeAnalyticsDb,
	closeAllAnalyticsDbs,
	analyticsDbPath,
	analyticsDbSize,
	ANALYTICS_DB_FILE,
	withTx,
} from "./connection.js";

export { initAnalyticsSchema, getAnalyticsSchemaVersion } from "./schema.js";

import { SqliteAnalyticsStore } from "./sqlite-store.js";
import { InMemoryAnalyticsStore } from "./memory-store.js";
import type { AnalyticsStore, AnalyticsStoreOptions } from "./types.js";

/**
 * Factory: create an AnalyticsStore from options.
 *
 * - Default: SqliteAnalyticsStore backed by analytics.db in stateDir
 * - inMemory: InMemoryAnalyticsStore (no file I/O)
 */
export function createAnalyticsStore(options: AnalyticsStoreOptions): AnalyticsStore {
	if (options.inMemory) {
		return new InMemoryAnalyticsStore(options);
	}
	return new SqliteAnalyticsStore(options);
}
