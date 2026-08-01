/**
 * gather-debug.ts — assemble a diagnostic bundle for bug reports.
 *
 * POST /api/maintenance/gather-debug → DebugBundleResponse. Reads local
 * SQLite + FS only (PREVENT-PI-004: zero network). Each section is non-fatal:
 * a read failure records `{ error }` for that section and continues, so the
 * bundle always returns 200 with whatever could be gathered.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import type { DebugBundleResponse } from "./api-contracts/maintenance.js";
import { defaultMetricsPath, defaultEventsPath } from "../../src/monitoring.js";
import { ownVersion } from "../mega-runtime/helpers.js";
import { MEGACOMPACT_ENV_KEYS } from "./gather-debug-keys.js";

/** Event-name patterns that indicate a critical/compaction class of error. */
const CRITICAL_PATTERN =
	/critical|overflow|already[.\s-]?compacted|compaction[.\s-]?failed|stream[.\s-]?death|poisoned|prefix_stability/i;

const require = createRequire(import.meta.url);

/** Lazy store opener (mirrors routes-maintenance.ts's lazyStoreUtils). */
function openStoreDb(ctx: RouteContext) {
	const mod = require("../../src/store/sqlite/utils.js") as typeof import("../../src/store/sqlite/utils.js");
	return mod.openStore(ctx.stateDir);
}

/** Lazy maintenance loaders (mirrors routes-maintenance.ts's lazyMaintenance). */
function loadMaintenance() {
	return require("../../src/store/sqlite/maintenance.js") as typeof import("../../src/store/sqlite/maintenance.js");
}

/** Send the debug bundle as JSON. Always 200 (partial on read failure). */
export function sendGatherDebug(res: ServerResponse, ctx: RouteContext): void {
	const result: DebugBundleResponse = {
		builtAt: Date.now(),
		version: ownVersion(),
		stateDir: ctx.stateDir,
		config: {},
		schemaHealth: { error: "not fetched" },
		storeStats: { error: "not fetched" },
		dashboardSnapshot: { error: "not fetched" },
		recentEvents: [],
		criticalEvents: [],
	};

	// 1. Config flags (no secrets — MEGACOMPACT_* only)
	for (const key of MEGACOMPACT_ENV_KEYS) {
		result.config[key] = process.env[key] ?? "<default>";
	}

	// 2. Schema health
	try {
		const maint = loadMaintenance();
		const integrity = maint.integrityCheck(ctx.stateDir);
		const db = openStoreDb(ctx);
		const metaRow = db
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get("schema_version") as { value: string } | undefined;
		const schemaVersion = metaRow ? Number(metaRow.value) : 0;
		const fkRows = db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
		result.schemaHealth = {
			type: "schema-health" as const,
			schemaVersion,
			integrity,
			fkCheck: fkRows.map((r) => JSON.stringify(r)),
			columns: [],
			healthy: true,
		};
	} catch (e) {
		result.schemaHealth = { error: e instanceof Error ? e.message : String(e) };
	}

	// 3. Store stats
	try {
		const maint = loadMaintenance();
		const raw = maint.getDbStats(ctx.stateDir);
		result.storeStats = {
			type: "db-stats" as const,
			tables: Object.entries(raw.tableCounts).map(([table, rowCount]) => ({ table, rowCount })),
			storage: {
				files: { dbBytes: raw.dbBytes, walBytes: raw.walBytes, shmBytes: raw.shmBytes },
				pageSize: raw.pageSize,
				pageCount: raw.pageCount,
				freelistPages: raw.freelistPages,
			},
		};
	} catch (e) {
		result.storeStats = { error: e instanceof Error ? e.message : String(e) };
	}

	// 4. Dashboard snapshot
	try {
		const path = defaultMetricsPath(ctx.stateDir);
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf-8");
			result.dashboardSnapshot = JSON.parse(raw) as unknown;
		} else {
			result.dashboardSnapshot = { error: "no snapshot" };
		}
	} catch (e) {
		result.dashboardSnapshot = { error: e instanceof Error ? e.message : String(e) };
	}

	// 5. Recent + critical events (tail ~200 lines of events.log)
	try {
		const path = defaultEventsPath(ctx.stateDir);
		if (existsSync(path)) {
			const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
			for (const line of lines.slice(-200)) {
				try {
					const ev = JSON.parse(line) as unknown;
					result.recentEvents.push(ev);
					if (CRITICAL_PATTERN.test(line)) result.criticalEvents.push(ev);
				} catch {
					continue; // skip unparseable line (PREVENT-001)
				}
			}
		}
	} catch (e) {
		result.recentEvents = [{ error: e instanceof Error ? e.message : String(e) }];
	}

	// Send (local helper to avoid importing sendJson from a non-exporting module)
	try {
		const body = JSON.stringify(result);
		res.writeHead(200, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(body);
	} catch {
		// last resort — never leave the response hanging
		res.writeHead(500, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end('{"error":"failed to serialize debug bundle"}');
	}
}
