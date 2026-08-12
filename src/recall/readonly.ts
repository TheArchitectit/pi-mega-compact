/**
 * recall/readonly.ts — read-only recall variant (3WF-3 Source A).
 *
 * A pure search+rank seam wrapping `engine.recall`'s RAW `hits` path. It is the
 * canonical read-only entry point going forward (triggerGuard.ts still inlines
 * `recall(...).hits` for its own need; this module is additive and does NOT
 * refactor it).
 *
 * HARD contract (QA): this module MUST NOT call `vectorMarkInjected`, must NOT
 * write any turn/recall rows, and must NOT emit S43 telemetry. It only searches
 * and returns hits for the vote. RecallAndInline's inject loop is the ONLY place
 * the injected-set is mutated; keying the vote on raw `hits` (skipInjected:false
 * => hits === newHits) is deliberate — `newHits` is post-`skipInjected` filter,
 * which would distort overlap appearance.
 *
 * Non-fatal: any failure returns [] so the caller degrades to other sources.
 * Pi-agnostic: no pi runtime imports.
 */
import { recall } from "../engine.js";
import type { VectorStore } from "../vectorStore.js";
import type { SearchHit } from "../vectorStore.js";

/** Options for the read-only recall seam. */
export interface ReadonlyRecallOptions {
	/** Normalized session id. */
	sessionId: string;
	/** Recall query text. */
	query: string;
	/** Max hits to return (default 3). */
	limit?: number;
}

/**
 * Raw, read-only recall hits for the 3-source vote. Returns `engine.recall`'s
 * RAW `.hits` (skipInjected:false => equals the unfiltered vector result). No
 * injected-set mutation, no turn writes, no telemetry. Returns [] on failure.
 */
export function recallRawHits(
	opts: ReadonlyRecallOptions,
	store: VectorStore,
): SearchHit[] {
	try {
		const result = recall(
			{
				sessionId: opts.sessionId,
				query: opts.query,
				limit: opts.limit ?? 3,
				skipInjected: false,
			},
			store,
		);
		return result.hits;
	} catch {
		// Non-fatal: never break the agent loop. Degrade to other sources.
		return [];
	}
}
