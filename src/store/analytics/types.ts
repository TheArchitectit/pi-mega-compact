/**
 * types.ts — PMA-1 contract module for the Provider/Model Analytics store.
 *
 * The source of truth. Every implementation (SQLite, in-memory) must satisfy
 * these interfaces. SQL schemas are private to implementations.
 *
 * Design principles (from docs/specs/provider-model-analytics-program.md):
 *   1. Contract-first — the interface IS the spec.
 *   2. Append-only — AnalyticsWriter.append* are the only write methods; no UPDATE.
 *   3. Capability-gated — asReader/asWriter/asAdmin return subset views.
 *   4. Host push/store pull — the host supplies facts; the store never initiates.
 *   5. Best effort — AppendResult identifies accepted/duplicate/failed without
 *      throwing into the host; analytics never interrupts the agent loop.
 *
 * PREVENT-PI-004: zero network. PREVENT-002: no SQL here (private to impls).
 */

// ─── Domain types ───────────────────────────────────────────────────

/** The kind of request-lifecycle event a fact records. */
export type RequestEventKind =
	| "request_started"
	| "provider_selected"
	| "first_token"
	| "request_completed"
	| "request_failed";

/** Where a fact was observed — the host adapter, not the store. */
export type FactSource = "host_adapter" | "backfill" | "test";

/** Data-quality annotations carried on every fact (nullable = unavailable). */
export interface QualityNote {
	/** Free-text note, e.g. "TTFT measured from turn_start, not before_provider_request". */
	note?: string;
	/** True when the value is estimated rather than directly measured. */
	estimated?: boolean;
	/** True when an expected field was unavailable (N/A, not zero). */
	unavailable?: boolean;
}

/**
 * A request-lifecycle fact — an immutable, append-only record of one event
 * in a model request's lifecycle (start, provider-selected, first-token,
 * completed, failed). Correlated by `(sessionId, turnIndex)` and optionally
 * by `correlationId`.
 */
export interface RequestEventFact {
	/** Stable host-generated id (TEXT PRIMARY KEY). */
	id: string;
	/** Links events belonging to the same request lifecycle. */
	correlationId?: string;
	sessionId?: string;
	repoId?: string;
	turnId?: string;
	eventKind: RequestEventKind;
	/** Epoch ms when the event was observed. */
	observedAt: number;
	provider?: string;
	model?: string;
	/** HTTP status code (for terminal events) or stop reason. */
	status?: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Request latency (observed start → observed terminal), ms. */
	durationMs?: number;
	/** Time-to-first-token, ms (N/A unless the first-token event was captured). */
	ttftMs?: number;
	source: FactSource;
	quality: QualityNote;
}

/**
 * A measurement sample — an immutable, append-only numeric metric point
 * (e.g. cache_hit_pct, tps, rss_mb). Distinct from request events because
 * measurements are sampled independently of the request lifecycle.
 */
export interface MeasurementFact {
	observedAt: number;
	sampleKind: string;
	provider?: string;
	model?: string;
	value: number;
	unit: string;
	correlationId?: string;
	source: FactSource;
	quality: QualityNote;
}

/**
 * An identity observation — an immutable, append-only record of a provider/model
 * identity snapshot (captured on model_select or session_start). Metadata is
 * JSON (pricing, context window, reasoning capability, etc.).
 */
export interface IdentityObservation {
	observedAt: number;
	provider?: string;
	model?: string;
	source: FactSource;
	metadata: Record<string, unknown>;
}

// ─── Write result ───────────────────────────────────────────────────

/** Outcome of an append operation. Never throws into the host. */
export type AppendResult =
	| { status: "accepted"; id: string | number }
	| { status: "duplicate"; id: string | number }
	| { status: "failed"; error: string };

// ─── Query / status result ──────────────────────────────────────────

/** Store + feature status (PMA-1: minimal; full queries arrive in PMA-3). */
export interface AnalyticsStatus {
	enabled: boolean;
	schemaVersion: number;
	requestEventCount: number;
	measurementCount: number;
	identityCount: number;
	/** Epoch ms of the most recent fact across all tables, or null when empty. */
	freshThrough: number | null;
}

// ─── Admin result types ─────────────────────────────────────────────

export interface PruneReport {
	eventsRemoved: number;
	measurementsRemoved: number;
	identitiesRemoved: number;
	freedBytes: number;
}

export interface IntegrityReport {
	ok: boolean;
	detail: string;
}

export interface MaintenanceReport {
	ok: boolean;
	detail: string;
}

export interface BackupReport {
	ok: boolean;
	path?: string;
	detail: string;
}

export interface RetentionPolicy {
	maxEventAgeMs: number;
	maxMeasurementAgeMs: number;
	vacuumAfterPrune: boolean;
}

// ─── Capability interfaces ──────────────────────────────────────────

/** Read-only view — dashboards, analytics, status checks. Cannot write. */
export interface AnalyticsReader {
	status(): AnalyticsStatus;
}

/** Append-only writer — event adapters, ingestion. Cannot prune or admin. */
export interface AnalyticsWriter {
	appendRequestEvent(fact: RequestEventFact): AppendResult;
	appendMeasurement(sample: MeasurementFact): AppendResult;
	appendIdentity(observation: IdentityObservation): AppendResult;
}

/** Admin operations — prune, maintenance, DR. */
export interface AnalyticsAdmin {
	prune(policy: RetentionPolicy): PruneReport;
	vacuum(): MaintenanceReport;
	integrityCheck(): IntegrityReport;
	backup(): BackupReport;
	clear(): void;
	close(): void;
}

/** The composed store — hosts get a capability-gated view. */
export interface AnalyticsStore extends AnalyticsReader, AnalyticsWriter, AnalyticsAdmin {
	/** Return a read-only view (for dashboards, status). */
	asReader(): AnalyticsReader;
	/** Return an append-only view (for event adapters, ingestion). */
	asWriter(): AnalyticsWriter;
	/** Return an admin view (for prune, maintenance, DR). */
	asAdmin(): AnalyticsAdmin;
}

// ─── Factory ────────────────────────────────────────────────────────

/** Options for creating an AnalyticsStore. */
export interface AnalyticsStoreOptions {
	stateDir: string;
	/** Override DB path (for tests / DR). Default: join(stateDir, "analytics.db") */
	dbPath?: string;
	/** In-memory mode (for tests). Default: false. */
	inMemory?: boolean;
}

/** Factory type — implementations provide the concrete constructor. */
export type AnalyticsStoreFactory = (options: AnalyticsStoreOptions) => AnalyticsStore;
