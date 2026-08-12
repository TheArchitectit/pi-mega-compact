/**
 * src/failback/floor.ts — the SHARED pure provenance-floor builder (3WF-4).
 *
 * Consolidation refactor (ZERO behavior change). Before this module the same
 * floor text was built twice:
 *   (a) `extensions/mega-events/context-handler/triggerGuard.ts` (3WF-1) —
 *       read checkpoints via `vectorList` (unfiltered), returned a bare string;
 *   (b) `src/recall/validator.ts` (3WF-3) — read checkpoints via
 *       `listCheckpoints` filtered to `dedupStatus !== "removed"`, returned a
 *       `FloorBlock`.
 * The three text variants were byte-identical between the two; only the
 * checkpoint READ differed. So this module takes the already-read checkpoint
 * list from the caller (staying pure — no store, no pi types, no I/O) and each
 * call site keeps its own read semantics. Output is byte-identical to both.
 *
 * 3WF-4's InjectionConfirm is the third consumer: when neither the message list
 * nor the runtime's pending blocks yield a block, it needs the SAME last-resort
 * floor text rather than a fourth copy.
 *
 * Non-fatal by construction: every branch returns a `FloorBlock`; the `none`
 * basis carries the shortest text (used when the checkpoint read itself threw).
 */
import type { StoredCheckpoint } from "../store.js";
import type { FloorBlock } from "./types.js";

/** Floor text when the newest checkpoint summary is available (prefix). */
const WITH_SUMMARY_PREFIX =
	"The following compacted context is the most recent checkpoint from " +
	"this session (recall found no query-relevant match):\n\n";

/** Floor text when checkpoints exist but no usable summary does. */
const NO_SUMMARY_TEXT =
	"This session has compacted context but recall could not surface a " +
	"checkpoint relevant to the current request; the most recent checkpoint " +
	"summary is unavailable.";

/** Floor text when the checkpoint read itself failed (hard last resort). */
export const FLOOR_UNAVAILABLE_TEXT =
	"This session has compacted context but recall could not surface a " +
	"checkpoint relevant to the current request.";

/** The newest checkpoint by timestamp (first element wins ties, as before). */
export function newestCheckpoint(
	cps: readonly StoredCheckpoint[],
): StoredCheckpoint | undefined {
	let newest = cps[0];
	for (const cp of cps) {
		if (!newest || (cp.timestamp ?? 0) > (newest.timestamp ?? 0)) newest = cp;
	}
	return newest;
}

/**
 * Build the provenance floor from an already-read checkpoint list. Pure: the
 * caller owns the read (and any dedup-status filtering), so both legacy call
 * sites keep byte-identical output.
 */
export function buildFloorBlock(
	cps: readonly StoredCheckpoint[],
): FloorBlock {
	const summary = newestCheckpoint(cps)?.summary?.trim();
	if (summary) {
		return { text: WITH_SUMMARY_PREFIX + summary, basis: "lastCheckpoint" };
	}
	return { text: NO_SUMMARY_TEXT, basis: "lastCheckpoint" };
}

/** The hard last-resort floor (checkpoint read unavailable or threw). */
export function unavailableFloorBlock(): FloorBlock {
	return { text: FLOOR_UNAVAILABLE_TEXT, basis: "none" };
}
