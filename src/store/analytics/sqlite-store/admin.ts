/**
 * admin.ts — AnalyticsAdmin delegate bodies for the SQLite backend.
 * Destructive/maintenance operations: prune, vacuum, integrityCheck, backup, clear, close.
 */
import { copyFileSync, existsSync } from "node:fs";
import type {
	RetentionPolicy,
	PruneReport,
	IntegrityReport,
	MaintenanceReport,
	BackupReport,
} from "../types.js";
import type { AnalyticsStoreCtx } from "./ctx.js";
import { withTx } from "../connection.js";
import { analyticsDbPath } from "../connection.js";

export function prune(ctx: AnalyticsStoreCtx, policy: RetentionPolicy): PruneReport {
	const now = Date.now();
	const eventCutoff = now - policy.maxEventAgeMs;
	const measCutoff = now - policy.maxMeasurementAgeMs;

	const delEvents = ctx.db
		.prepare("DELETE FROM request_events WHERE observed_at < ?")
		.run(eventCutoff) as { changes?: number };
	const delMeas = ctx.db
		.prepare("DELETE FROM measurement_samples WHERE observed_at < ?")
		.run(measCutoff) as { changes?: number };
	// Identity observations are not age-pruned (they're low-volume snapshots).

	if (policy.vacuumAfterPrune) {
		try {
			ctx.db.exec("VACUUM");
		} catch {
			/* non-fatal */
		}
	}

	return {
		eventsRemoved: delEvents.changes ?? 0,
		measurementsRemoved: delMeas.changes ?? 0,
		identitiesRemoved: 0,
		freedBytes: 0,
	};
}

export function vacuum(ctx: AnalyticsStoreCtx): MaintenanceReport {
	try {
		ctx.db.exec("VACUUM");
		return { ok: true, detail: "VACUUM completed" };
	} catch (e) {
		return { ok: false, detail: String(e) };
	}
}

export function integrityCheck(ctx: AnalyticsStoreCtx): IntegrityReport {
	try {
		const row = ctx.db.prepare("PRAGMA integrity_check").get() as
			| { integrity_check: string }
			| undefined;
		const result = row?.integrity_check ?? "ok";
		return { ok: result === "ok", detail: result };
	} catch (e) {
		return { ok: false, detail: String(e) };
	}
}

export function backup(ctx: AnalyticsStoreCtx): BackupReport {
	if (ctx.opts.inMemory) {
		return { ok: false, detail: "Cannot backup an in-memory database" };
	}
	try {
		// WAL-safe checkpoint before copy.
		ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		const src = analyticsDbPath(ctx.stateDir);
		if (!existsSync(src)) return { ok: false, detail: "analytics.db not found" };
		const dest = `${src}.bak-${Date.now()}`;
		copyFileSync(src, dest);
		return { ok: true, path: dest, detail: `Backup written to ${dest}` };
	} catch (e) {
		return { ok: false, detail: String(e) };
	}
}

export function clear(ctx: AnalyticsStoreCtx): void {
	withTx(ctx.db, () => {
		ctx.db.exec("DELETE FROM request_events");
		ctx.db.exec("DELETE FROM measurement_samples");
		ctx.db.exec("DELETE FROM identity_observations");
		// Reset AUTOINCREMENT sequences for measurement_samples + identity_observations.
		try {
			ctx.db.exec("DELETE FROM sqlite_sequence WHERE name IN ('measurement_samples', 'identity_observations')");
		} catch {
			/* non-fatal: sqlite_sequence may not exist yet */
		}
	});
}
