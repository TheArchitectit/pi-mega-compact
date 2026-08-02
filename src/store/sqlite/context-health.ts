/**
 * context-health.ts — `context_health` and `cache_poison_events` table accessors.
 *
 * Append-only per-turn Context Health metrics recorded during compactSession:
 * drift_score, output_quality, error_score, cache_health, cache_poison,
 * composite, repetition_ratio, coherence_score, and prefix_hash.
 *
 * Also records cache-poison advisory events when cache corruption/inconsistency
 * is detected at a given cache layer.
 *
 * PREVENT-PI-004: local SQLite only, zero network.
 * PREVENT-002: all SQL uses ? placeholders, no string-concatenated values.
 * Pi-agnostic: no pi runtime types.
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

// ─── Shared row types ────────────────────────────────────────────────────────

/** A single context_health row (as stored + returned). */
export interface ContextHealthRow {
	id: number;
	ts: number;
	turnIndex: number;
	sessionId: string;
	driftScore: number;
	outputQuality: number;
	errorScore: number;
	cacheHealth: number;
	cachePoison: number;
	composite: number;
	modelId: string | null;
	repetitionRatio: number | null;
	coherenceScore: number | null;
	prefixHash: string | null;
}

/** Latest summary row (most recent by ts). */
export interface LatestContextHealth {
	composite: number;
	driftScore: number;
	outputQuality: number;
	errorScore: number;
	cacheHealth: number;
	cachePoison: number;
	ts: number;
	modelId: string | null;
}

/** A single cache_poison_events row (as stored + returned). */
export interface CachePoisonEvent {
	id: number;
	ts: number;
	turnIndex: number;
	sessionId: string;
	layer: number | null;
	detail: string | null;
	severity: string | null;
}

// ─── context_health accessors ────────────────────────────────────────────────

/**
 * Record one context health sample. All values are fully parameterized
 * (PREVENT-002). Optional columns (model_id, repetition_ratio, coherence_score,
 * prefix_hash) are passed as-is; the column list enumerates every field so
 * missing optional fields are NULL in the row.
 *
 * Non-fatal: any write error is logged to stderr and silently swallowed so
 * instrumentation can never block the agent loop.
 */
export function recordContextHealthRow(
	stateDir: string = getStateDir(),
	row: {
		ts: number;
		turnIndex: number;
		sessionId: string;
		driftScore: number;
		outputQuality: number;
		errorScore: number;
		cacheHealth: number;
		cachePoison: number;
		composite: number;
		modelId?: string;
		repetitionRatio?: number;
		coherenceScore?: number;
		prefixHash?: string;
	},
): void {
	try {
		const db = openStore(stateDir);
		db.prepare(
			`INSERT INTO context_health
			   (ts, turn_index, session_id, drift_score, output_quality,
			    error_score, cache_health, cache_poison, composite,
			    model_id, repetition_ratio, coherence_score, prefix_hash)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.ts,
			row.turnIndex,
			row.sessionId,
			row.driftScore,
			row.outputQuality,
			row.errorScore,
			row.cacheHealth,
			row.cachePoison,
			row.composite,
			row.modelId ?? null,
			row.repetitionRatio ?? null,
			row.coherenceScore ?? null,
			row.prefixHash ?? null,
		);
	} catch (err) {
		// Non-fatal: log and continue — health sampling must never block the agent.
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[context-health] recordContextHealthRow error: ${msg}\n`);
	}
}

/**
 * Read context health rows since `sinceTs`. When `modelId` is provided the
 * query adds an AND filter; otherwise all models are returned. Results are
 * ordered ascending by ts. Returns an empty array on any error (non-fatal).
 *
 * SQL is fully parameterized (PREVENT-002).
 */
export function readContextHealthRows(
	stateDir: string = getStateDir(),
	sinceTs: number,
	modelId?: string,
): ContextHealthRow[] {
	try {
		const db = openStore(stateDir);
		let rows: Array<{
			id: number;
			ts: number;
			turn_index: number;
			session_id: string;
			drift_score: number;
			output_quality: number;
			error_score: number;
			cache_health: number;
			cache_poison: number;
			composite: number;
			model_id: string | null;
			repetition_ratio: number | null;
			coherence_score: number | null;
			prefix_hash: string | null;
		}>;

		if (modelId != null) {
			rows = db
				.prepare(
					`SELECT id, ts, turn_index, session_id, drift_score, output_quality,
					        error_score, cache_health, cache_poison, composite,
					        model_id, repetition_ratio, coherence_score, prefix_hash
					 FROM context_health
					 WHERE ts >= ? AND model_id = ?
					 ORDER BY ts ASC`,
				)
				.all(sinceTs, modelId) as typeof rows;
		} else {
			rows = db
				.prepare(
					`SELECT id, ts, turn_index, session_id, drift_score, output_quality,
					        error_score, cache_health, cache_poison, composite,
					        model_id, repetition_ratio, coherence_score, prefix_hash
					 FROM context_health
					 WHERE ts >= ?
					 ORDER BY ts ASC`,
				)
				.all(sinceTs) as typeof rows;
		}

		return rows.map((r) => ({
			id: r.id,
			ts: r.ts,
			turnIndex: r.turn_index,
			sessionId: r.session_id,
			driftScore: r.drift_score,
			outputQuality: r.output_quality,
			errorScore: r.error_score,
			cacheHealth: r.cache_health,
			cachePoison: r.cache_poison,
			composite: r.composite,
			modelId: r.model_id,
			repetitionRatio: r.repetition_ratio,
			coherenceScore: r.coherence_score,
			prefixHash: r.prefix_hash,
		}));
	} catch {
		// Non-fatal: return empty array on DB error.
		return [];
	}
}

/**
 * Read the most recent context_health row (ORDER BY ts DESC LIMIT 1).
 * Returns null when no rows exist or on any error.
 */
export function readLatestContextHealth(
	stateDir: string = getStateDir(),
): LatestContextHealth | null {
	try {
		const db = openStore(stateDir);
		const row = db
			.prepare(
				`SELECT composite, drift_score, output_quality, error_score,
				        cache_health, cache_poison, ts, model_id
				 FROM context_health
				 ORDER BY ts DESC
				 LIMIT 1`,
			)
			.get() as
			| {
					composite: number;
					drift_score: number;
					output_quality: number;
					error_score: number;
					cache_health: number;
					cache_poison: number;
					ts: number;
					model_id: string | null;
				}
			| undefined;

		if (!row) return null;
		return {
			composite: row.composite,
			driftScore: row.drift_score,
			outputQuality: row.output_quality,
			errorScore: row.error_score,
			cacheHealth: row.cache_health,
			cachePoison: row.cache_poison,
			ts: row.ts,
			modelId: row.model_id,
		};
	} catch {
		return null;
	}
}

/**
 * Read the trailing `limit` composite scores (most recent first), then reverse
 * to chronological order for sparkline rendering. Returns an empty array when
 * no rows exist or on any error.
 *
 * SQL is fully parameterized (PREVENT-002).
 */
export function readContextHealthTrend(
	stateDir: string = getStateDir(),
	limit: number,
): number[] {
	try {
		const db = openStore(stateDir);
		const rows = db
			.prepare(
				`SELECT composite FROM context_health
				 ORDER BY ts DESC LIMIT ?`,
			)
			.all(limit) as Array<{ composite: number }>;

		// Reverse to chronological (oldest first) for sparkline display.
		return rows.map((r) => r.composite).reverse();
	} catch {
		return [];
	}
}

// ─── cache_poison_events accessors ───────────────────────────────────────────

/**
 * Record one cache poison advisory event. Fully parameterized (PREVENT-002).
 * Non-fatal: write errors are logged to stderr and silently swallowed.
 */
export function recordCachePoisonEvent(
	stateDir: string = getStateDir(),
	event: {
		ts: number;
		turnIndex: number;
		sessionId: string;
		layer: number;
		detail: string;
		severity: "warn" | "alert";
	},
): void {
	try {
		const db = openStore(stateDir);
		db.prepare(
			`INSERT INTO cache_poison_events
			   (ts, turn_index, session_id, layer, detail, severity)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(event.ts, event.turnIndex, event.sessionId, event.layer, event.detail, event.severity);
	} catch (err) {
		// Non-fatal: advisory logging must never block the agent loop.
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[context-health] recordCachePoisonEvent error: ${msg}\n`);
	}
}

/**
 * Read cache poison events since `sinceTs`, ordered descending by ts (most
 * recent first), capped at 100 rows. Returns an empty array on any error
 * (non-fatal). SQL is fully parameterized (PREVENT-002).
 */
export function readCachePoisonEvents(
	stateDir: string = getStateDir(),
	sinceTs: number,
): CachePoisonEvent[] {
	try {
		const db = openStore(stateDir);
		const rows = db
			.prepare(
				`SELECT id, ts, turn_index, session_id, layer, detail, severity
				 FROM cache_poison_events
				 WHERE ts >= ?
				 ORDER BY ts DESC
				 LIMIT 100`,
			)
			.all(sinceTs) as Array<{
			id: number;
			ts: number;
			turn_index: number;
			session_id: string;
			layer: number | null;
			detail: string | null;
			severity: string | null;
		}>;

		return rows.map((r) => ({
			id: r.id,
			ts: r.ts,
			turnIndex: r.turn_index,
			sessionId: r.session_id,
			layer: r.layer,
			detail: r.detail,
			severity: r.severity,
		}));
	} catch {
		return [];
	}
}