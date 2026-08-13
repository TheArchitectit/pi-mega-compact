/**
 * contextHealth.ts — Context Health scoring engine.
 *
 * Composite scoring + SQLite persistence for session-level context quality
 * telemetry. The three sub-scoring modules are:
 *   outputQuality.ts — assistant output text analysis
 *   drift.ts         — rolling-window topic / error / prefix drift
 *
 * All SQL is fully parameterized (PREVENT-002). The `context_health` table
 * is created inline on first write so this module is self-contained and does
 * not require schema.ts to be modified (no existing files touched).
 *
 * PREVENT-PI-004: local SQLite only, zero network. All I/O is node:sqlite.
 * PREVENT-011: no `any` — all row shapes are typed.
 */
import { openStore } from "./store/sqlite/utils.js";

// ─── Composite score ─────────────────────────────────────────────────────────

/** Sub-scores fed into the composite health score. */
export interface ContextHealthSubScores {
	/** Topic drift score (0–1, higher = less drift). */
	drift: number;
	/** Output quality score (0–1, higher = healthier output). */
	outputQuality: number;
	/** Error-rate score (0–1, higher = fewer API-retry errors). */
	errorRate: number;
	/** Cache health score (0–1, higher = healthier cache). */
	cacheHealth: number;
	/** Cache poison score (0–1, higher = less poison). */
	cachePoison: number;
	/**
	 * Store-error rate score (0–1, higher = fewer internal store-write
	 * failures). Sprint H (B2): a SEPARATE 6th axis from `errorRate` — `errorRate`
	 * reflects API-retry errors only; `storeErrorRate` reflects internal
	 * store/service-write failures (turn rows, recall, dbMirror, ledger, epoch,
	 * stats, memory consolidate, compact persist, vector index, embedder,
	 * migration). The two are equally loud at 0.09 each.
	 */
	storeErrorRate: number;
}

/**
 * Weighted composite health score from six sub-dimensions (Sprint H — B2).
 *
 * Weights:
 *   output quality  22% — primary measure of model output health
 *   drift           22% — session-level coherence
 *   cache poison    20% — prompt-cache integrity
 *   cache health    18% — cache hit rate stability
 *   error rate       9% — API-retry error frequency (split from 18%)
 *   store error      9% — internal store-write failure frequency (NEW 6th axis)
 *
 * The 0.18 `errorRate` budget was split into `errorRate 0.09` +
 * `storeErrorRate 0.09` so a silent store-write failure is as visible as a
 * retryable API error. Weights sum to 1.0. NOTE (step-change): historical
 * context_health rows keep their stored composite (point-in-time snapshots — no
 * backfill), so the trend line shows a boundary step where weights change.
 *
 * Returns 0–1: 1 = fully healthy, 0 = severely degraded.
 */
export function computeHealthScore(sub: ContextHealthSubScores): number {
	const raw =
		sub.outputQuality * 0.22 +
		sub.drift * 0.22 +
		sub.cachePoison * 0.20 +
		sub.cacheHealth * 0.18 +
		sub.errorRate * 0.09 +
		sub.storeErrorRate * 0.09;
	return Math.max(0, Math.min(1, raw));
}

// ─── SQLite persistence ───────────────────────────────────────────────────────

/** A single row as stored in + returned from the context_health table. */
export interface ContextHealthRow {
	ts: number;
	turnIndex: number;
	sessionId: string;
	driftScore: number;
	outputQuality: number;
	errorScore: number;
	cacheHealth: number;
	cachePoison: number;
	composite: number;
	/** Sprint H (B2): 6th axis — internal store-write failure score (0–1). */
	storeErrorScore?: number;
	modelId?: string;
	repetitionRatio?: number;
	coherenceScore?: number;
	prefixHash?: string;
}

/**
 * Record one context health sample into the SQLite store.
 *
 * Non-fatal: errors are caught and silently ignored so instrumentation never
 * blocks the agent loop. Table schema is owned by schema.ts (SCHEMA_VERSION 5).
 *
 * PREVENT-002: all values are bound as parameters (? placeholders).
 */
export function recordContextHealth(
	stateDir: string,
	row: ContextHealthRow,
): void {
	try {
		const db = openStore(stateDir);
		db.prepare(
			`INSERT INTO context_health
       (ts, session_id, turn_index, drift_score, output_quality,
        error_score, cache_health, cache_poison, composite, store_error_score,
        model_id, repetition_ratio, coherence_score, prefix_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.ts,
			row.sessionId,
			row.turnIndex,
			row.driftScore,
			row.outputQuality,
			row.errorScore,
			row.cacheHealth,
			row.cachePoison,
			row.composite,
			row.storeErrorScore ?? null,
			row.modelId ?? null,
			row.repetitionRatio ?? null,
			row.coherenceScore ?? null,
			row.prefixHash ?? null,
		);
	} catch {
		/* non-fatal: context health instrumentation never blocks the agent loop */
	}
}

/**
 * Read context health samples since `sinceTs`, optionally filtered by modelId.
 *
 * Returns rows in ascending ts order. Non-fatal (empty array on error).
 *
 * PREVENT-002: modelId is bound as a parameter (? placeholder).
 * PREVENT-001: row.meta column (if added later) is handled by null-safe reads.
 */
export function readContextHealth(
	stateDir: string,
	sinceTs: number,
	modelId?: string,
): ContextHealthRow[] {
	try {
		const db = openStore(stateDir);
		const sql = modelId
			? `SELECT ts, session_id, turn_index, drift_score, output_quality,
              error_score, cache_health, cache_poison, composite,
              model_id, repetition_ratio, coherence_score, prefix_hash
         FROM context_health
         WHERE ts >= ? AND model_id = ?
         ORDER BY ts ASC`
			: `SELECT ts, session_id, turn_index, drift_score, output_quality,
              error_score, cache_health, cache_poison, composite,
              model_id, repetition_ratio, coherence_score, prefix_hash
         FROM context_health
         WHERE ts >= ?
         ORDER BY ts ASC`;
		const params = modelId ? [sinceTs, modelId] : [sinceTs];
		const rows = db.prepare(sql).all(...params) as Array<{
			ts: number;
			session_id: string;
			turn_index: number;
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
		const out: ContextHealthRow[] = [];
		for (const r of rows) {
			out.push({
				ts: r.ts,
				sessionId: r.session_id,
				turnIndex: r.turn_index,
				driftScore: r.drift_score,
				outputQuality: r.output_quality,
				errorScore: r.error_score,
				cacheHealth: r.cache_health,
				cachePoison: r.cache_poison,
				composite: r.composite,
				modelId: r.model_id ?? undefined,
				repetitionRatio: r.repetition_ratio ?? undefined,
				coherenceScore: r.coherence_score ?? undefined,
				prefixHash: r.prefix_hash ?? undefined,
			});
		}
		return out;
	} catch {
		return [];
	}
}

// ─── Re-exports for consumers ────────────────────────────────────────────────

export { computeOutputQuality } from "./contextHealth/outputQuality.js";
export {
	computeTopicDrift,
	computeErrorEscalation,
	computePrefixInstability,
	computeDriftScore,
} from "./contextHealth/drift.js";