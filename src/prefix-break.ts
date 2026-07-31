/**
 * prefix-break.ts — S53A prefix-break classification.
 *
 * Classifies WHY the provider cache prefix broke on a given turn by comparing
 * the break timestamp against the three candidate event timestamps with a
 * configurable tolerance window.
 *
 * The classification is best-effort (non-fatal): null timestamps are absent,
 * and a break outside all tolerance windows is classified as 'other'.
 *
 * Pi-agnostic: no pi runtime types, no network.
 */

export interface PrefixBreakMeta {
	/** Which event caused the break. */
	cause: "recall" | "compaction" | "inject" | "other";
	/** Confidence score 0.0–1.0 based on proximity to the matched event. */
	confidence: number;
	/** Cache hit % immediately before the break. */
	prevHitPct: number;
	/** Cache hit % of the first degraded sample. */
	currHitPct: number;
	/** Wall-clock ms of the break sample. */
	breakAt: number;
}

export interface PrefixBreak {
	id: number;
	ts: number;
	kind: "prefix_break";
	value: number;
	meta: PrefixBreakMeta;
}

/**
 * Timestamps of recent events that can cause a prefix break.
 * All values are wall-clock ms (Date.now()) or null if no event has occurred.
 */
export interface EventTimestamps {
	lastRecallAt: number | null;
	lastCompactAt: number | null;
	lastInjectAt: number | null;
}

/**
 * Classify why the provider cache prefix broke at `breakTimestamp`.
 *
 * @param breakTimestamp  Wall-clock ms of the cache hit % drop sample.
 * @param events          Recent event timestamps from the runtime.
 * @param toleranceMs     Max ms gap to consider a match (default 2000).
 * @returns Classification result with cause + confidence.
 *
 * Priority: recall > compaction > inject.  Confidence = 1 − (gap / (2·tolerance)),
 * capped at [0.5, 1.0].  Returns 'other' when no event is within tolerance.
 */
export function classifyPrefixBreak(
	breakTimestamp: number,
	events: EventTimestamps,
	toleranceMs = 2000,
): { cause: "recall" | "compaction" | "inject" | "other"; confidence: number } {
	// Ordered by priority (recall wins if multiple match).
	const candidates: Array<{
		cause: "recall" | "compaction" | "inject";
		ts: number | null;
	}> = [
		{ cause: "recall", ts: events.lastRecallAt },
		{ cause: "compaction", ts: events.lastCompactAt },
		{ cause: "inject", ts: events.lastInjectAt },
	];

	for (const { cause, ts } of candidates) {
		if (ts == null) continue;
		const gap = Math.abs(breakTimestamp - ts);
		if (gap <= toleranceMs) {
			// confidence = 1 − (gap / (2·tolerance)) ∈ [0.5, 1.0]
			// exact match (gap=0) → 1.0;  at boundary (gap=tolerance) → 0.5
			const confidence = Math.max(0.5, 1 - gap / (2 * toleranceMs));
			return { cause, confidence };
		}
	}

	return { cause: "other", confidence: 0 };
}