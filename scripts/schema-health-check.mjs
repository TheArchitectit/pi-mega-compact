#!/usr/bin/env node
/**
 * scripts/schema-health-check.mjs — S49B deploy gate.
 *
 * Validates that every column declared in the maintenance API contract
 * actually exists in the live SQLite schema. Fails hard (exit 1) if any
 * column is missing, any FK constraint is violated, or integrity_check fails.
 *
 * Usage: node scripts/schema-health-check.mjs [--db <path>]
 *
 * Default DB: ~/.pi/mega-compact/sqlite.db
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// --- column registry (must match maintenance.ts contract) -------------------
// Each module that owns tables declares them here as:
//   [table, column, expected SQL type decl]

const EXPECTED_COLUMNS = [
	// src/store/sqlite/schema.ts — core tables
	["checkpoint_epochs", "epoch_id", "TEXT NOT NULL PRIMARY KEY"],
	["checkpoint_epochs", "parent_epoch_id", "TEXT"],
	["checkpoint_epochs", "compressed_json", "TEXT NOT NULL"],
	["checkpoint_epochs", "compressed_len", "INTEGER NOT NULL DEFAULT 0"],
	["checkpoint_epochs", "compression_ratio", "REAL NOT NULL DEFAULT 1.0"],
	["checkpoint_epochs", "created_at", "TEXT NOT NULL DEFAULT (datetime('now'))"],

	["context_chunks", "chunk_id", "TEXT NOT NULL PRIMARY KEY"],
	["context_chunks", "epoch_id", "TEXT NOT NULL"],
	["context_chunks", "content", "TEXT NOT NULL"],
	["context_chunks", "embedding_blob", "BLOB"],
	["context_chunks", "token_count", "INTEGER NOT NULL DEFAULT 0"],
	["context_chunks", "role", "TEXT NOT NULL DEFAULT 'user'"],
	["context_chunks", "agent_id", "TEXT NOT NULL DEFAULT ''"],
	["context_chunks", "conversation_id", "TEXT NOT NULL DEFAULT ''"],
	["context_chunks", "turn_index", "INTEGER NOT NULL DEFAULT 0"],
	["context_chunks", "created_at", "TEXT NOT NULL DEFAULT (datetime('now'))"],
	["context_chunks", "expires_at", "TEXT"],

	["session_state", "key", "TEXT NOT NULL PRIMARY KEY"],
	["session_state", "value", "TEXT NOT NULL"],
	["session_state", "updated_at", "TEXT NOT NULL DEFAULT (datetime('now'))"],

	["raw_transcript", "transcript_id", "TEXT NOT NULL PRIMARY KEY"],
	["raw_transcript", "epoch_id", "TEXT NOT NULL"],
	["raw_transcript", "json", "TEXT NOT NULL"],
	["raw_transcript", "created_at", "TEXT NOT NULL DEFAULT (datetime('now'))"],

	// dedup_mirror
	["dedup_mirror", "digest", "TEXT NOT NULL"],
	["dedup_mirror", "chunk_id", "TEXT"],
	["dedup_mirror", "source_epoch_id", "TEXT"],
	["dedup_mirror", "tier", "TEXT NOT NULL DEFAULT 'l0'"],
	["dedup_mirror", "cluster_id", "TEXT"],
	["dedup_mirror", "hit_count", "INTEGER NOT NULL DEFAULT 0"],
	["dedup_mirror", "last_seen_at", "TEXT NOT NULL DEFAULT (datetime('now'))"],

	// contexts_fts (virtual)
	["contexts_fts", "content", ""],

	// archive
	["archive_manifest", "archive_id", "TEXT NOT NULL PRIMARY KEY"],
	["archive_manifest", "base_epoch_id", "TEXT NOT NULL"],
	["archive_manifest", "compressed_json", "TEXT NOT NULL"],
	["archive_manifest", "compressed_len", "INTEGER NOT NULL DEFAULT 0"],
	["archive_manifest", "compression_ratio", "REAL NOT NULL DEFAULT 1.0"],
	["archive_manifest", "created_at", "TEXT NOT NULL DEFAULT (datetime('now'))"],
];

// --- main -------------------------------------------------------------------
const args = process.argv.slice(2);
let dbPath = resolve(homedir(), ".pi", "mega-compact", "sqlite.db");

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--db" && args[i + 1]) {
		dbPath = args[++i];
	}
}

if (!existsSync(dbPath)) {
	console.error(`[schema-health-check] DB not found at ${dbPath} — skipping (cold install OK)`);
	process.exit(0);
}

let failures = 0;
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");

// 1. integrity_check ---------------------------------------------------------
try {
	const rows = db.prepare("PRAGMA integrity_check").all();
	for (const row of rows) {
		const val = row.integrity_check ?? row["integrity_check"] ?? "";
		if (val !== "ok") {
			console.error(`[schema-health-check] integrity_check FAIL: ${val}`);
			failures++;
		}
	}
} catch (err) {
	console.error(`[schema-health-check] integrity_check error: ${err?.message ?? err}`);
	failures++;
}

// 2. FK check ----------------------------------------------------------------
try {
	const rows = db.prepare("PRAGMA foreign_key_check").all();
	if (rows.length > 0) {
		for (const row of rows) {
			console.error(`[schema-health-check] FK violation: table=${row.table} rowid=${row.rowid} parent=${row.parent} fkid=${row.fkid}`);
		}
		failures += rows.length;
	}
} catch (err) {
	console.error(`[schema-health-check] FK check error: ${err?.message ?? err}`);
	failures++;
}

// 3. Column audit (contract vs. DB) ------------------------------------------
for (const [table, column] of EXPECTED_COLUMNS) {
	try {
		const rows = db.prepare(`PRAGMA table_info('${table}')`).all();
		const found = rows.some((r) => r.name === column);
		if (!found) {
			console.error(`[schema-health-check] Missing column: ${table}.${column}`);
			failures++;
		}
	} catch {
		// Table doesn't exist — that's a failure for every column of that table
		console.error(`[schema-health-check] Missing table: ${table}`);
		failures++;
	}
}

// 4. MIRROR sanity -----------------------------------------------------------
try {
	const orphanCount = db.prepare(
		`SELECT COUNT(*) AS c FROM dedup_mirror WHERE chunk_id NOT IN (SELECT chunk_id FROM context_chunks)`
	).get();
	if (orphanCount && orphanCount.c > 0) {
		console.error(`[schema-health-check] WARNING: ${orphanCount.c} orphan dedup_mirror rows (reconcile-dedup will fix)`);
		// Non-fatal — reconcile-dedup fixes these
	}
} catch {
	// Non-fatal
}

db.close();

if (failures > 0) {
	console.error(`\n[schema-health-check] ${failures} failure(s) found. Deploy blocked.`);
	console.error("Run the maintenance tab reconcile actions, then re-run this script.");
	process.exit(1);
}

console.log("[schema-health-check] all checks passed.");
process.exit(0);
