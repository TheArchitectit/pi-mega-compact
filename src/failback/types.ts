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

/** A competing compaction summary candidate produced by the 3-source vote. */
export interface CompactCandidate {
	/** Which generator produced this candidate (structural telemetry label —
	 *  never infer the source by sniffing the summary text). */
	source: "extractive" | "cluster";
	/** The candidate summary text (extractive or cluster/raptor variant). */
	summary: string;
	/** Estimated token cost of the candidate summary (estimateBlockTokens basis). */
	tokenEstimate: number;
	/** True when the summary preserves every recent user request signal. */
	signalPreserved: boolean;
}

/**
 * The measured reduction verdict across consecutive `context` events in the
 * LIVE WINDOW (the model's current working tokens), NOT the stored-checkpoint
 * `saved` metric. The live-window `currentTokens` delta is the real signal of
 * whether compaction actually freed working context; the stored `saved` field
 * is a cumulative SQLite total that can look healthy while the live window is
 * unchanged — the false metric behind the production thrash bug this sprint
 * fixes. `liveBefore`/`liveAfter` are the live-window token counts bracketing
 * the compaction.
 */
export interface ReductionVerdict {
	/** True when the live window measurably shrank after compaction. */
	effective: boolean;
	/** Live-window token count before the compaction event. */
	liveBefore: number;
	/** Live-window token count after the compaction event. */
	liveAfter: number;
}

/**
 * State of the compaction thrash guard. Arms after a compaction that produced
 * no live-window reduction, so we do not re-fire into a window that cannot
 * shrink. Re-arms or clears as the live window grows again.
 */
export interface ThrashGuardState {
	/** Live-window token count below which re-firing is refused (guard active). */
	blockedUntilTokens: number;
	/** ms epoch at which the guard was armed. */
	armedAt: number;
}
