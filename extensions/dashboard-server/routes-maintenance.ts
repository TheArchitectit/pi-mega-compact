/**
 * dashboard-server/routes-maintenance.ts — S49B Maintenance tab API routes.
 *
 * Handlers for:
 *   GET  /api/maintenance            — DB stats (table row counts + storage)
 *   GET  /api/maintenance/schema-health — SCHEMA_VERSION + integrity audit
 *   POST /api/maintenance/action     — Trigger a maintenance action
 *
 * All pi-agnostic; lazy-requires maintenance primitives to avoid a top-level
 * import of the store from the dashboard server process. PREVENT-PI-004: local
 * SQLite only; zero network calls.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./routes-core.js";

// ---------------------------------------------------------------------------
// Lazy imports (via createRequire)
// ---------------------------------------------------------------------------

const lazyMaintenance = (() => {
	let mod: typeof import("../../src/store/sqlite/maintenance.js") | null = null;
	return () => {
		if (!mod)
			mod = createRequire(import.meta.url)(
				"../../src/store/sqlite/maintenance.js",
			) as typeof import("../../src/store/sqlite/maintenance.js");
		return mod;
	};
})();

const lazyStoreUtils = (() => {
	let mod: typeof import("../../src/store/sqlite/utils.js") | null = null;
	return () => {
		if (!mod)
			mod = createRequire(import.meta.url)(
				"../../src/store/sqlite/utils.js",
			) as typeof import("../../src/store/sqlite/utils.js");
		return mod;
	};
})();

// ---------------------------------------------------------------------------
// Types for JSON deserialisation
// ---------------------------------------------------------------------------

interface MaintenanceActionBody {
	action: string;
	daysOld?: number | string;
}

// ---------------------------------------------------------------------------
// GET /api/maintenance and sub-paths
// ---------------------------------------------------------------------------

export function handleMaintenance(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	if (!url.startsWith("/api/maintenance")) return false;

	const method = (req.method ?? "GET").toUpperCase();

	// ── GET /api/maintenance/schema-health ────────────────────────────
	if (method === "GET" && url === "/api/maintenance/schema-health") {
		sendSchemaHealth(res, ctx);
		return true;
	}

	// ── POST /api/maintenance/action ──────────────────────────────────
	if (method === "POST" && url === "/api/maintenance/action") {
		handleMaintenanceAction(req, res, ctx);
		return true;
	}

	// ── GET /api/maintenance ──────────────────────────────────────────
	if (method === "GET" && url === "/api/maintenance") {
		sendDbStats(res, ctx);
		return true;
	}

	// ── Unknown sub-path ──────────────────────────────────────────────
	sendJson(res, 404, { error: "not found" });
	return true;
}

// ---------------------------------------------------------------------------
// GET /api/maintenance — DB stats
// ---------------------------------------------------------------------------

function sendDbStats(res: ServerResponse, ctx: RouteContext): void {
	try {
		const { getDbStats } = lazyMaintenance();
		const raw = getDbStats(ctx.stateDir);

		const tables = Object.entries(raw.tableCounts).map(([table, rowCount]) => ({
			table,
			rowCount,
		}));

		sendJson(res, 200, {
			type: "db-stats" as const,
			tables,
			storage: {
				files: {
					dbBytes: raw.dbBytes,
					walBytes: raw.walBytes,
					shmBytes: raw.shmBytes,
				},
				pageSize: raw.pageSize,
				pageCount: raw.pageCount,
				freelistPages: raw.freelistPages,
			},
		});
	} catch (err) {
		sendJson(res, 500, { error: (err as Error).message });
	}
}

// ---------------------------------------------------------------------------
// GET /api/maintenance/schema-health — schema version + integrity audit
// ---------------------------------------------------------------------------

function sendSchemaHealth(res: ServerResponse, ctx: RouteContext): void {
	try {
		const { integrityCheck } = lazyMaintenance();
		const integrity = integrityCheck(ctx.stateDir);

		const { openStore } = lazyStoreUtils();
		const db = openStore(ctx.stateDir);

		// SCHEMA_VERSION from meta table
		const metaRow = db
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get("schema_version") as { value: string } | undefined;
		const schemaVersion = metaRow ? Number(metaRow.value) : 0;

		// PRAGMA foreign_key_check
		const fkRows = db.prepare("PRAGMA foreign_key_check").all() as Array<
			Record<string, unknown>
		>;
		const fkCheck = fkRows.map((r) => JSON.stringify(r));

		// Per-column audit: every ensureColumn migration column declared in
		// schema.ts, checked via PRAGMA table_info (read-only).
		const expectedColumns: Array<{
			table: string;
			column: string;
			decl: string;
		}> = [
			{
				table: "context_chunks",
				column: "original_token_estimate",
				decl: "INTEGER",
			},
			{ table: "raw_transcript", column: "content_ref", decl: "TEXT" },
			{ table: "memories", column: "category", decl: "TEXT" },
			{ table: "memories", column: "target", decl: "TEXT" },
			{ table: "memories", column: "last_referenced", decl: "INTEGER" },
			{ table: "memories", column: "source_turn", decl: "INTEGER" },
			{ table: "raptor_nodes", column: "built_at", decl: "INTEGER" },
			{ table: "raw_transcript", column: "turn_index", decl: "INTEGER" },
			{ table: "session_state", column: "conversation_id", decl: "TEXT" },
			{ table: "session_state", column: "last_turn_id", decl: "INTEGER" },
		];

		const columns = expectedColumns.map((ec) => {
			const cols = db.prepare(`PRAGMA table_info(${ec.table})`).all() as Array<{
				name: string;
			}>;
			const present = cols.some((c) => c.name === ec.column);
			return {
				table: ec.table,
				column: ec.column,
				present,
				expectedDecl: ec.decl,
			};
		});

		const healthy =
			integrity.length === 1 &&
			integrity[0] === "ok" &&
			columns.every((c) => c.present);

		sendJson(res, 200, {
			type: "schema-health" as const,
			schemaVersion,
			integrity,
			fkCheck,
			columns,
			healthy,
		});
	} catch (err) {
		sendJson(res, 500, { error: (err as Error).message });
	}
}

// ---------------------------------------------------------------------------
// POST /api/maintenance/action — Trigger a maintenance action
// ---------------------------------------------------------------------------

function handleMaintenanceAction(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): void {
	let body = "";
	req.setEncoding("utf8");
	req.on("data", (chunk: string) => {
		body += chunk;
		if (body.length > 10_000) req.destroy();
	});
	req.on("end", () => {
		let payload: MaintenanceActionBody;
		try {
			payload = JSON.parse(body) as MaintenanceActionBody;
			if (!payload || !payload.action) {
				sendJson(res, 400, { error: "missing 'action' field" });
				return;
			}
		} catch {
			sendJson(res, 400, { error: "invalid JSON" });
			return;
		}

		try {
			const m = lazyMaintenance();
			const u = lazyStoreUtils();
			// All destructive actions: temp backup first
			if (payload.action !== "integrity-check") {
				// Non-blocking — backup failure is non-fatal
				m.backupDb(ctx.stateDir);
			}

			switch (payload.action) {
				case "vacuum": {
					const r = m.vacuumDb(ctx.stateDir);
					sendJson(res, 200, {
						operation: "vacuum",
						success: true,
						affected: r.affected,
						reclaimedBytes: r.reclaimedBytes,
						summary: r.summary,
					});
					return;
				}
				case "checkpoint": {
					const r = m.checkpointWal(ctx.stateDir);
					sendJson(res, 200, {
						operation: "checkpoint",
						success: true,
						affected: r.affected,
						reclaimedBytes: r.reclaimedBytes,
						summary: r.summary,
					});
					return;
				}
				case "reindex": {
					const db = u.openStore(ctx.stateDir);
					db.exec("REINDEX");
					sendJson(res, 200, {
						operation: "reindex",
						success: true,
						affected: 0,
						reclaimedBytes: 0,
						summary: "REINDEX completed",
					});
					return;
				}
				case "fts5-rebuild": {
					const db = u.openStore(ctx.stateDir);
					db.exec(
						"INSERT INTO context_chunks_trgm(context_chunks_trgm) VALUES('rebuild')",
					);
					sendJson(res, 200, {
						operation: "fts5-rebuild",
						success: true,
						affected: 0,
						reclaimedBytes: 0,
						summary: "FTS5 rebuild triggered",
					});
					return;
				}
				case "reconcile-dedup": {
					const r = m.reconcileDedupMirror(ctx.stateDir);
					const lines: string[] = [];
					if (r.fixedRefCount)
						lines.push(`${r.fixedRefCount} ref_counts corrected`);
					if (r.orphansDeleted)
						lines.push(`${r.orphansDeleted} orphans deleted`);
					if (r.refsBackfilled)
						lines.push(`${r.refsBackfilled} refs backfilled`);
					sendJson(res, 200, {
						operation: "reconcile-dedup",
						success: true,
						affected: r.fixedRefCount + r.orphansDeleted + r.refsBackfilled,
						reclaimedBytes: 0,
						summary: lines.length ? lines.join(", ") : "nothing to fix",
					});
					return;
				}
				case "prune": {
					const days = Number(payload.daysOld) || 30;
					const r = m.pruneOldRows(ctx.stateDir, days);
					sendJson(res, 200, {
						operation: "prune",
						success: true,
						affected: r.affected,
						reclaimedBytes: r.reclaimedBytes,
						summary: r.summary,
					});
					return;
				}
				case "integrity-check": {
					const lines = m.integrityCheck(ctx.stateDir);
					sendJson(res, 200, {
						operation: "integrity-check",
						success: lines.length === 1 && lines[0] === "ok",
						affected: 0,
						reclaimedBytes: 0,
						summary: lines.join("; "),
						detail: lines,
					});
					return;
				}
				default:
					sendJson(res, 400, {
						error: `unknown action: ${payload.action}`,
					});
			}
		} catch (err) {
			sendJson(res, 500, { error: (err as Error).message });
		}
	});
}

// ---------------------------------------------------------------------------
// JSON helper
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}
