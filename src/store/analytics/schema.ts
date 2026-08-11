/**
 * schema.ts — PMA-1 DDL for analytics.db.
 *
 * Idempotent (CREATE IF NOT EXISTS). One statement per exec so a failure names
 * the exact table. Matches the schema defined in
 * docs/specs/provider-model-analytics-program.md §6.
 *
 * PREVENT-PI-004: no network. PREVENT-002: no interpolated identifiers.
 */
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

/**
 * Initialize the analytics.db schema. Safe to call on every open — every
 * statement is CREATE IF NOT EXISTS.
 */
export function initAnalyticsSchema(db: DatabaseSync): void {
	// ── Lifecycle tables ──────────────────────────────────────────────

	db.exec(`
		CREATE TABLE IF NOT EXISTS analytics_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS analytics_schema (
			version    INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL,
			digest     TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS analytics_migrations (
			id                TEXT PRIMARY KEY,
			started_at        INTEGER NOT NULL,
			completed_at      INTEGER,
			source_fingerprint TEXT,
			rows_copied       INTEGER,
			status            TEXT NOT NULL,
			detail            TEXT
		)
	`);

	// ── Append-only fact tables ───────────────────────────────────────

	db.exec(`
		CREATE TABLE IF NOT EXISTS request_events (
			id                 TEXT PRIMARY KEY,
			correlation_id     TEXT,
			session_id         TEXT,
			repo_id            TEXT,
			turn_id            TEXT,
			event_kind         TEXT NOT NULL CHECK(event_kind IN (
				'request_started',
				'provider_selected',
				'first_token',
				'request_completed',
				'request_failed'
			)),
			observed_at        INTEGER NOT NULL,
			provider           TEXT,
			model              TEXT,
			status             TEXT,
			input_tokens       INTEGER,
			output_tokens      INTEGER,
			cache_read_tokens  INTEGER,
			cache_write_tokens INTEGER,
			duration_ms        REAL,
			ttft_ms            REAL,
			source             TEXT NOT NULL,
			quality_json       TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS measurement_samples (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			observed_at     INTEGER NOT NULL,
			sample_kind     TEXT NOT NULL,
			provider        TEXT,
			model           TEXT,
			value           REAL NOT NULL,
			unit            TEXT NOT NULL,
			correlation_id  TEXT,
			source          TEXT NOT NULL,
			quality_json    TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS identity_observations (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			observed_at    INTEGER NOT NULL,
			provider       TEXT,
			model          TEXT,
			source         TEXT NOT NULL,
			metadata_json  TEXT NOT NULL
		)
	`);

	// ── Indexes (spec §6) ─────────────────────────────────────────────

	db.exec(`CREATE INDEX IF NOT EXISTS idx_request_events_observed_at ON request_events(observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_request_events_provider_observed ON request_events(provider, observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_request_events_model_observed ON request_events(model, observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_request_events_kind_observed ON request_events(event_kind, observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_request_events_correlation ON request_events(correlation_id, observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_measurement_samples_kind_observed ON measurement_samples(sample_kind, observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_measurement_samples_provider_model ON measurement_samples(provider, model, observed_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_identity_obs_provider_model ON identity_observations(provider, model, observed_at)`);

	// ── Schema version stamp (insert-only, never overwrites) ─────────

	const existing = db
		.prepare("SELECT value FROM analytics_meta WHERE key = 'schema_version'")
		.get() as { value: string } | undefined;
	if (!existing) {
		db.prepare("INSERT INTO analytics_meta (key, value) VALUES ('schema_version', ?)")
			.run(String(SCHEMA_VERSION));
		db.prepare("INSERT INTO analytics_schema (version, applied_at, digest) VALUES (?, ?, ?)")
			.run(SCHEMA_VERSION, Date.now(), "pma-1-initial");
	}
}

/** The current analytics schema version. */
export function getAnalyticsSchemaVersion(): number {
	return SCHEMA_VERSION;
}
