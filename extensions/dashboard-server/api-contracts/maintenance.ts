/**
 * api-contracts/maintenance.ts — Maintenance tab API contract (S49B).
 *
 * Types for the /api/maintenance and /api/maintenance/action endpoints.
 * All pi-agnostic, all PREVENT-PI-004 compliant (type definitions only).
 */

/** Row count + size stats per SQLite table. */
export interface TableStats {
	/** Table name. */
	table: string;
	/** Row count (or -1 if FTS virtual table). */
	rowCount: number;
}

/** DB file sizes on disk in bytes. */
export interface DbFiles {
	/** Main sqlite.db size. */
	dbBytes: number;
	/** WAL sidecar size (0 if absent). */
	walBytes: number;
	/** SHM sidecar size (0 if absent). */
	shmBytes: number;
}

/** SQLite storage-level stats. */
export interface DbStorageStats {
	files: DbFiles;
	pageSize: number;
	pageCount: number;
	freelistPages: number;
}

/** Full table + storage overview (GET /api/maintenance result). */
export interface DbStatsResponse {
	type: "db-stats";
	/** Per-table row counts. */
	tables: TableStats[];
	/** Storage stats. */
	storage: DbStorageStats;
}

/** Result of a single maintenance action. */
export interface MaintenanceActionResult {
	operation: string;
	success: boolean;
	affected: number;
	reclaimedBytes: number;
	summary: string;
	detail?: string[];
}

/** Schema health check — per-column audit result. */
export interface SchemaHealthRow {
	table: string;
	column: string;
	present: boolean;
	expectedDecl: string;
}

/** Schema health audit (GET /api/maintenance/schema-health). */
export interface SchemaHealthResponse {
	type: "schema-health";
	/** SCHEMA_VERSION constant compiled in. */
	schemaVersion: number;
	/** PRAGMA integrity_check result lines. */
	integrity: string[];
	/** PRAGMA foreign_key_check result lines. */
	fkCheck: string[];
	/** Per-column audit of every ensureColumn migration column. */
	columns: SchemaHealthRow[];
	/** All present = healthy. */
	healthy: boolean;
}

/** Maintenance actions the client can trigger (POST /api/maintenance/action). */
export type MaintenanceAction =
	| { action: "vacuum" }
	| { action: "checkpoint" }
	| { action: "reindex" }
	| { action: "fts5-rebuild" }
	| { action: "reconcile-dedup" }
	| { action: "prune"; daysOld: number }
	| { action: "integrity-check" };
