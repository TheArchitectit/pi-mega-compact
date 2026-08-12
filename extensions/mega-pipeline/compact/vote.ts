/**
 * vote.ts — 3WF-2 observational vote wiring (thin adapter over
 * src/failback/compact.ts). The ONLY behavior addition in Track A.
 *
 * Runs ONLY when the 3WF umbrella flag (config.threeWayFailback) is ON. After
 * compactSession returns a non-skipped result, it votes the two competing
 * summary candidates for the compacted region (`view.slice(0, keepFrom)` — the
 * same slice compactSession compacts). The outcome is LOGGED (structured
 * `compact_vote` event) and is purely observational: supersede (src/engine.ts:143)
 * stays the unchanged precondition, result.summary is NOT overwritten, and no
 * checkpoint is re-persisted. A null vote (rejected by the floor) means "keep
 * the supersede-only result", which is exactly what happens when we don't touch
 * the result. Flag OFF ⇒ this function is never called (byte-identical to
 * v0.20.83). Non-fatal: the caller wraps it in try/catch and swallows.
 */

import type { EngineMessage } from "../../../src/types.js";
import { voteCandidate } from "../../../src/failback/compact.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import type { RunCompactResult } from "./run.js";

/**
 * Wire the observational 3-source vote after a successful compaction.
 * @param runtime   the shared mega runtime (logger + dashboard).
 * @param config    mega config (flag gate).
 * @param sid       normalized session id.
 * @param result    the compactSession result (unmodified by this call).
 * @param view      the full engine view (region = view.slice(0, keepFrom)).
 * @param keepFrom  index where the verbatim tail starts.
 */
export function wireCompactVote(
	runtime: MegaRuntime,
	config: MegaConfig,
	sid: string,
	result: Extract<RunCompactResult, { skipped: false }>["result"],
	view: EngineMessage[],
	keepFrom: number,
): void {
	// Flag OFF ⇒ do nothing (byte-identical to v0.20.83 behavior).
	if (!config.threeWayFailback) return;

	const tokensBefore = result.originalTokenEstimate;
	const region = view.slice(0, keepFrom);
	const winner = voteCandidate(region, tokensBefore);

	// Observational only: pick a stable label for telemetry.
	let label = "none";
	let reduction = 0;
	let signalPreserved = false;
	let rejectedByFloor = false;
	if (winner) {
		// Structural label from the candidate itself — never sniff the summary text.
		label = winner.source;
		reduction = tokensBefore - winner.tokenEstimate;
		signalPreserved = winner.signalPreserved;
	} else {
		// Distinguish "no candidate" from "candidate rejected by the floor".
		// A null return from voteCandidate means the winner scored below the floor
		// (or there were no candidates) — i.e. keep the supersede-only result.
		rejectedByFloor = true;
	}

	runtime.logger?.info("compact_vote", {
		sessionId: sid,
		checkpointId: result.checkpointId ?? "(deduped)",
		winner: label,
		reduction,
		signalPreserved,
		rejectedByFloor,
		tokensBefore,
	});
	try {
		runtime.dashboard?.event("compact_vote", {
			sessionId: sid,
			checkpointId: result.checkpointId ?? "(deduped)",
			winner: label,
			reduction,
			signalPreserved,
			rejectedByFloor,
		});
	} catch {
		/* non-fatal: dashboard probe must never break a compaction */
	}
}
