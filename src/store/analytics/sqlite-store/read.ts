/**
 * read.ts — AnalyticsReader delegate bodies for the SQLite backend.
 * PMA-1: minimal (status only). Full queries (providers/models/live/detailed)
 * arrive in PMA-3.
 */
import type { AnalyticsStatus } from "../types.js";
import type { AnalyticsStoreCtx } from "./ctx.js";
import { getAnalyticsSchemaVersion } from "../schema.js";

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
