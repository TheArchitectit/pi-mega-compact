/**
 * src/failback/types.ts — 3WF Three-Way Failback contract types (contract-first).
 *
 * Pure, pi-agnostic interfaces describing the staged-recall guarantee chain:
 * every session should have a staged recall block even when `session_start`
 * never fires. 3WF-1 (TriggerGuard) is the first consumer; 3WF-2/3/4 extend
 * these shapes for the compaction ladder, the 3-source recall vote, and
 * InjectionConfirm. No pi runtime imports, no store mutation — these are the
 * shape contract only.
 */

/** One-shot guard state for a session (observable result of a TriggerGuard run). */
export interface TriggerGuardState {
	/** True once a recall/floor attempt has run for this session. */
	recallRan: boolean;
	/** The block staged into runtime.pendingRecallBlock (null when nothing staged). */
	stagedBlock: string | null;
	/** True when the provenance floor (not a recall hit) was staged. */
	usedFloor: boolean;
}

/** A provenance floor string built from the newest checkpoint / session basis. */
export interface FloorBlock {
	/** The model-visible floor text. */
	text: string;
	/** Why this floor was produced. */
	basis: "lastCheckpoint" | "sessionProvenance" | "none";
}

/** Result of a single TriggerGuard evaluation (for tests + telemetry). */
export interface GuardRunResult {
	/** How the block (or non-block) was produced. */
	source: "already-staged" | "recall" | "floor" | "none";
	/** The staged block text; null when nothing was staged. */
	block: string | null;
}

/** Options the TriggerGuard needs to run a staged recall. */
export interface GuardOpts {
	/** The latest user message used as the recall query; empty => 'none'. */
	query: string | null;
	/** Normalized session id. */
	sessionId: string;
	/** Max hits to recall (mirrors autoInlineK). */
	limit: number;
}
