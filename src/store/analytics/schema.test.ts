/**
 * schema.test.ts — analytics.db DDL integrity tests.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAnalyticsDb, closeAllAnalyticsDbs } from "./connection.js";
import { getAnalyticsSchemaVersion } from "./schema.js";
import type { DatabaseSync } from "node:sqlite";

let baseTmp: string;
let dir: string;
let db: DatabaseSync;

beforeEach(() => {
	baseTmp = mkdtempSync(join(tmpdir(), "mc-analytics-schema-"));
	dir = join(baseTmp, "run");
	db = openAnalyticsDb(dir);
});

afterEach(() => {
	closeAllAnalyticsDbs();
	rmSync(baseTmp, { recursive: true, force: true });
});

test("schema version is stamped in analytics_meta", () => {
	const row = db.prepare("SELECT value FROM analytics_meta WHERE key = 'schema_version'").get() as { value: string };
	assert.equal(Number(row.value), getAnalyticsSchemaVersion());
});

test("schema version is stamped in analytics_schema table", () => {
	const row = db.prepare("SELECT version FROM analytics_schema ORDER BY version DESC LIMIT 1").get() as { version: number };
	assert.equal(row.version, 1);
});

test("initAnalyticsSchema is idempotent (re-open does not duplicate)", () => {
	closeAllAnalyticsDbs();
	db = openAnalyticsDb(dir); // re-open same dir
	const versions = db.prepare("SELECT COUNT(*) AS c FROM analytics_schema").get() as { c: number };
	assert.equal(versions.c, 1, "only one schema version row");
});

test("all fact tables exist", () => {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all() as Array<{ name: string }>;
	const names = tables.map((t) => t.name);
	assert.ok(names.includes("request_events"));
	assert.ok(names.includes("measurement_samples"));
	assert.ok(names.includes("identity_observations"));
	assert.ok(names.includes("analytics_meta"));
	assert.ok(names.includes("analytics_schema"));
	assert.ok(names.includes("analytics_migrations"));
});

test("event_kind CHECK constraint rejects invalid values", () => {
	assert.throws(() => {
		db.prepare(
			`INSERT INTO request_events (id, event_kind, observed_at, source, quality_json) VALUES (?, ?, ?, ?, ?)`,
		).run("bad1", "invalid_kind", Date.now(), "test", "{}");
	}, /CHECK constraint failed/);
});

test("event_kind CHECK accepts all allowed values", () => {
	for (const kind of ["request_started", "provider_selected", "first_token", "request_completed", "request_failed"]) {
		db.prepare(
			`INSERT INTO request_events (id, event_kind, observed_at, source, quality_json) VALUES (?, ?, ?, ?, ?)`,
		).run(`test_${kind}`, kind, Date.now(), "test", "{}");
	}
	const count = db.prepare("SELECT COUNT(*) AS c FROM request_events").get() as { c: number };
	assert.equal(count.c, 5);
});

test("all spec indexes exist", () => {
	const indexes = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
		.all() as Array<{ name: string }>;
	const names = indexes.map((i) => i.name);
	// The 8 spec indexes.
	assert.ok(names.includes("idx_request_events_observed_at"));
	assert.ok(names.includes("idx_request_events_provider_observed"));
	assert.ok(names.includes("idx_request_events_model_observed"));
	assert.ok(names.includes("idx_request_events_kind_observed"));
	assert.ok(names.includes("idx_request_events_correlation"));
	assert.ok(names.includes("idx_measurement_samples_kind_observed"));
	assert.ok(names.includes("idx_measurement_samples_provider_model"));
	assert.ok(names.includes("idx_identity_obs_provider_model"));
});
