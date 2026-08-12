/**
 * memory-store.ts — InMemoryAnalyticsStore: Map-backed dual backend.
 *
 * Mirrors the turns store pattern (src/store/turns/memory-store.ts).
 * Satisfies the same contract so the compliance suite runs against both
 * backends unchanged.
 */
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
	AnalyticsEventFilter,
	AnalyticsEventPage,
	RetentionPolicy,
	PruneReport,
	IntegrityReport,
	MaintenanceReport,
	BackupReport,
} from "./types.js";
import { getAnalyticsSchemaVersion } from "./schema.js";

interface MeasurementRow extends MeasurementFact {
	id: number;
}
interface IdentityRow extends IdentityObservation {
	id: number;
}

export class InMemoryAnalyticsStore implements AnalyticsStore {
	private events: Map<string, RequestEventFact> = new Map();
	private measurements: MeasurementRow[] = [];
	private identities: IdentityRow[] = [];
	private nextId = 1;

	constructor(_options?: AnalyticsStoreOptions) {
		// Options unused — the in-memory store doesn't open a DB.
	}

	private allocId(): number {
		return this.nextId++;
	}

	// ── AnalyticsReader ───────────────────────────────────────────────

	status(): AnalyticsStatus {
		const lastEvent = this.events.size > 0
			? Math.max(...[...this.events.values()].map((e) => e.observedAt))
			: 0;
		const lastMeas = this.measurements.length > 0
			? Math.max(...this.measurements.map((m) => m.observedAt))
			: 0;
		const lastId = this.identities.length > 0
			? Math.max(...this.identities.map((i) => i.observedAt))
			: 0;
		return {
			enabled: true,
			schemaVersion: getAnalyticsSchemaVersion(),
			requestEventCount: this.events.size,
			measurementCount: this.measurements.length,
			identityCount: this.identities.length,
			freshThrough: Math.max(lastEvent, lastMeas, lastId) || null,
		};
	}

	listEvents(filter?: AnalyticsEventFilter): AnalyticsEventPage {
		const f = filter ?? {};
		const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
		const offset = Math.max(f.offset ?? 0, 0);
		let all = [...this.events.values()];
		if (f.fromMs != null) all = all.filter((e) => e.observedAt >= f.fromMs!);
		if (f.toMs != null) all = all.filter((e) => e.observedAt <= f.toMs!);
		if (f.provider != null) all = all.filter((e) => e.provider === f.provider);
		if (f.model != null) all = all.filter((e) => e.model === f.model);
		if (f.status != null) all = all.filter((e) => e.status === f.status);
		if (f.eventKind != null) all = all.filter((e) => e.eventKind === f.eventKind);
		all.sort((a, b) => b.observedAt - a.observedAt);
		const total = all.length;
		const page = all.slice(offset, offset + limit);
		return { events: page, total, hasMore: offset + page.length < total };
	}

	// ── AnalyticsWriter ───────────────────────────────────────────────

	appendRequestEvent(fact: RequestEventFact): AppendResult {
		if (this.events.has(fact.id)) {
			return { status: "duplicate", id: fact.id };
		}
		this.events.set(fact.id, { ...fact });
		return { status: "accepted", id: fact.id };
	}

	appendMeasurement(sample: MeasurementFact): AppendResult {
		const id = this.allocId();
		this.measurements.push({ ...sample, id });
		return { status: "accepted", id };
	}

	appendIdentity(observation: IdentityObservation): AppendResult {
		const id = this.allocId();
		this.identities.push({ ...observation, id });
		return { status: "accepted", id };
	}

	// ── AnalyticsAdmin ────────────────────────────────────────────────

	prune(policy: RetentionPolicy): PruneReport {
		const now = Date.now();
		const eventCutoff = now - policy.maxEventAgeMs;
		const measCutoff = now - policy.maxMeasurementAgeMs;
		const beforeE = this.events.size;
		const beforeM = this.measurements.length;
		for (const [k, e] of this.events) {
			if (e.observedAt < eventCutoff) this.events.delete(k);
		}
		this.measurements = this.measurements.filter((m) => m.observedAt >= measCutoff);
		return {
			eventsRemoved: beforeE - this.events.size,
			measurementsRemoved: beforeM - this.measurements.length,
			identitiesRemoved: 0,
			freedBytes: 0,
		};
	}

	vacuum(): MaintenanceReport {
		return { ok: true, detail: "no-op for in-memory store" };
	}

	integrityCheck(): IntegrityReport {
		return { ok: true, detail: "ok" };
	}

	backup(): BackupReport {
		return { ok: false, detail: "Cannot backup an in-memory database" };
	}

	clear(): void {
		this.events.clear();
		this.measurements = [];
		this.identities = [];
		this.nextId = 1;
	}

	close(): void {
		this.clear();
	}

	// ── Capability views ──────────────────────────────────────────────

	asReader(): AnalyticsReader {
		return {
			status: () => this.status(),
			listEvents: (f) => this.listEvents(f),
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
