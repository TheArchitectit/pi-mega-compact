/**
 * read.ts — AnalyticsReader delegate bodies for the SQLite backend.
 * PMA-1: minimal (status only). Full queries (providers/models/live/detailed)
 * arrive in PMA-3.
 */
import type { AnalyticsStatus, AnalyticsEventFilter, AnalyticsEventPage } from "../types.js";
import type { AnalyticsStoreCtx } from "./ctx.js";
import { getAnalyticsSchemaVersion } from "../schema.js";
import { rowToRequestEvent } from "./rows.js";

export function status(ctx: AnalyticsStoreCtx): AnalyticsStatus {
	const eventCount = (
		ctx.db.prepare("SELECT COUNT(*) AS c FROM request_events").get() as { c: number }
	).c;
	const measurementCount = (
		ctx.db.prepare("SELECT COUNT(*) AS c FROM measurement_samples").get() as { c: number }
	).c;
	const identityCount = (
		ctx.db.prepare("SELECT COUNT(*) AS c FROM identity_observations").get() as { c: number }
	).c;
	// Freshness: the most recent observed_at across all three fact tables.
	const lastEvent = (
		ctx.db
			.prepare("SELECT MAX(observed_at) AS mx FROM request_events")
			.get() as { mx: number | null }
	).mx;
	const lastMeas = (
		ctx.db
			.prepare("SELECT MAX(observed_at) AS mx FROM measurement_samples")
			.get() as { mx: number | null }
	).mx;
	const lastId = (
		ctx.db
			.prepare("SELECT MAX(observed_at) AS mx FROM identity_observations")
			.get() as { mx: number | null }
	).mx;
	const freshThrough = Math.max(lastEvent ?? 0, lastMeas ?? 0, lastId ?? 0) || null;

	return {
		enabled: true,
		schemaVersion: getAnalyticsSchemaVersion(),
		requestEventCount: eventCount,
		measurementCount,
		identityCount,
		freshThrough,
	};
}

export function listEvents(ctx: AnalyticsStoreCtx, filter?: AnalyticsEventFilter): AnalyticsEventPage {
	const f = filter ?? {};
	const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
	const offset = Math.max(f.offset ?? 0, 0);

	// Build dynamic WHERE clause with allowlisted fields only (PREVENT-002).
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	if (f.fromMs != null) { conditions.push("observed_at >= ?"); params.push(f.fromMs); }
	if (f.toMs != null) { conditions.push("observed_at <= ?"); params.push(f.toMs); }
	if (f.provider != null) { conditions.push("provider = ?"); params.push(f.provider); }
	if (f.model != null) { conditions.push("model = ?"); params.push(f.model); }
	if (f.status != null) { conditions.push("status = ?"); params.push(f.status); }
	if (f.eventKind != null) { conditions.push("event_kind = ?"); params.push(f.eventKind); }
	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	// Count total matching rows (for pagination).
	const countRow = ctx.db
		.prepare(`SELECT COUNT(*) AS c FROM request_events ${where}`)
		.get(...params) as { c: number };
	const total = countRow.c;

	// Fetch the page.
	const rows = ctx.db
		.prepare(`SELECT * FROM request_events ${where} ORDER BY observed_at DESC LIMIT ? OFFSET ?`)
		.all(...params, limit, offset) as Array<Record<string, unknown>>;
	const events = rows.map(rowToRequestEvent);

	return {
		events,
		total,
		hasMore: offset + events.length < total,
	};
}
