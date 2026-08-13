/**
 * context-health-cache-poison.ts — `cache_poison_events` table accessors.
 *
 * Extracted from context-health.ts (Sprint H split — context-health.ts crossed
 * the soft limit when storeErrorScore was added). Records cache-poison advisory
 * events when cache corruption/inconsistency is detected at a given cache layer.
 *
 * PREVENT-PI-004: local SQLite only, zero network.
 * PREVENT-002: all SQL uses ? placeholders, no string-concatenated values.
 * Pi-agnostic: no pi runtime types.
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

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

/**
 * Record one cache-poison advisory event. All values are fully parameterized
 * (PREVENT-002). Non-fatal: any write error is logged to stderr and silently
 * swallowed so advisory logging never blocks the agent loop.
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
