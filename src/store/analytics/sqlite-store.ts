/**
 * sqlite-store.ts — SqliteAnalyticsStore: thin delegate shell for the SQLite
 * analytics backend. Mirrors the turns store pattern (src/store/turns/sqlite-store.ts).
 *
 * Every method delegates to a function in sqlite-store/{read,write,admin}.ts.
 * Capability gating: asReader/asWriter/asAdmin return fresh object literals
 * exposing ONLY that interface's methods — never `this`.
 */
import type { DatabaseSync } from "node:sqlite";
import type {
	AnalyticsStore,
	AnalyticsReader,
	AnalyticsWriter,
	AnalyticsAdmin,
	AnalyticsStoreOptions,
	RequestEventFact,
	MeasurementFact,
	IdentityObservation,
	AppendResult,
	AnalyticsStatus,
	RetentionPolicy,
	PruneReport,
	IntegrityReport,
	MaintenanceReport,
	BackupReport,
} from "./types.js";
import { openAnalyticsDb, closeAnalyticsDb } from "./connection.js";
import type { AnalyticsStoreCtx } from "./sqlite-store/ctx.js";
import * as read from "./sqlite-store/read.js";
import * as write from "./sqlite-store/write.js";
import * as admin from "./sqlite-store/admin.js";

export class SqliteAnalyticsStore implements AnalyticsStore {
	private db: DatabaseSync;
	private readonly stateDir: string;
	private readonly opts: AnalyticsStoreOptions;

	constructor(options: AnalyticsStoreOptions) {
		this.opts = options;
		this.stateDir = options.stateDir;
		this.db = openAnalyticsDb(options.stateDir, {
			dbPath: options.dbPath,
			inMemory: options.inMemory,
		});
	}

	private ctx(): AnalyticsStoreCtx {
		return { db: this.db, stateDir: this.stateDir, opts: this.opts };
	}

	// ── AnalyticsReader ───────────────────────────────────────────────

	status(): AnalyticsStatus {
		return read.status(this.ctx());
	}

	// ── AnalyticsWriter ───────────────────────────────────────────────

	appendRequestEvent(fact: RequestEventFact): AppendResult {
		return write.appendRequestEvent(this.ctx(), fact);
	}
	appendMeasurement(sample: MeasurementFact): AppendResult {
		return write.appendMeasurement(this.ctx(), sample);
	}
	appendIdentity(observation: IdentityObservation): AppendResult {
		return write.appendIdentity(this.ctx(), observation);
	}

	// ── AnalyticsAdmin ────────────────────────────────────────────────

	prune(policy: RetentionPolicy): PruneReport {
		return admin.prune(this.ctx(), policy);
	}
	vacuum(): MaintenanceReport {
		return admin.vacuum(this.ctx());
	}
	integrityCheck(): IntegrityReport {
		return admin.integrityCheck(this.ctx());
	}
	backup(): BackupReport {
		return admin.backup(this.ctx());
	}
	clear(): void {
		admin.clear(this.ctx());
	}
	close(): void {
		closeAnalyticsDb(this.stateDir, {
			dbPath: this.opts.dbPath,
			inMemory: this.opts.inMemory,
		});
	}

	// ── Capability views ──────────────────────────────────────────────

	asReader(): AnalyticsReader {
		return {
			status: () => this.status(),
		};
	}

	asWriter(): AnalyticsWriter {
		return {
			appendRequestEvent: (f) => this.appendRequestEvent(f),
			appendMeasurement: (s) => this.appendMeasurement(s),
			appendIdentity: (o) => this.appendIdentity(o),
		};
	}

	asAdmin(): AnalyticsAdmin {
		return {
			prune: (p) => this.prune(p),
			vacuum: () => this.vacuum(),
			integrityCheck: () => this.integrityCheck(),
			backup: () => this.backup(),
			clear: () => this.clear(),
			close: () => this.close(),
		};
	}
}
