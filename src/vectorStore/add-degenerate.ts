/**
 * add-degenerate.ts — the L1/L2 degenerate-match decliner bound to one add().
 *
 * Split out of add.ts to keep it under the 300-line src/ soft limit (the same
 * sibling-helper pattern as add-l0.ts / add-l1.ts). The PREDICATE lives in
 * src/dedup/degenerate.ts alongside the other dedup primitives; what lives here
 * is only the cascade-side glue: the telemetry the decision emits and the
 * boolean the two call sites branch on.
 *
 * See src/dedup/degenerate.ts for the incident (2026-08-19) this guards against.
 */
import type { StoredCheckpoint } from "../store.js";
import { shouldSkipDegenerateMatch } from "../dedup/degenerate.js";
import type { DegenerateGuardTunables } from "../dedup/degenerate.js";
import type { DedupAuditRecorder } from "./dedup-audit.js";
import type { VectorStore } from "./class.js";
import type { AddInput } from "./types.js";

/** Declines one fuzzy-tier match; true ⇒ treat the match as if it never happened. */
export type DegenerateDecliner = (
	tier: "L1" | "L2",
	matched: StoredCheckpoint,
	similarity?: number,
) => boolean;

/**
 * Build the decliner for one add() cascade.
 *
 * Returns a predicate the L1/L2 call sites use as a one-line guard. When it
 * returns true it has ALREADY recorded the declined decision (monitoring event +
 * `skipped` audit line + the live `onTier` detail), so the caller only has to
 * fall through. When the umbrella flag is off it always returns false and emits
 * nothing — byte-identical to the pre-guard cascade.
 */
export function degenerateDecliner(args: {
	store: VectorStore;
	input: AddInput;
	/** This candidate's content hash — blocks declining an exact-content match. */
	contentHash: string;
	cfg: DegenerateGuardTunables;
	audit: DedupAuditRecorder;
	/** Cascade start time, for the latency field on the monitoring event. */
	t0: number;
}): DegenerateDecliner {
	const { store, input, contentHash, cfg, audit, t0 } = args;
	const candidate = { ...input, contentHash };
	return (tier, matched, similarity) => {
		if (!shouldSkipDegenerateMatch(matched, candidate, cfg)) return false;
		// Reported as `mark_only`: a tier matched but policy declined to collapse —
		// exactly the existing MARK_ONLY shape, with a distinct reason string so the
		// dashboard can tell a guard decline from an operator-configured MARK_ONLY.
		store.record(
			tier,
			"mark_only",
			"degenerateGuard",
			Date.now() - t0,
			similarity,
			matched.checkpointId,
		);
		audit.skipped(tier, matched.checkpointId, "degenerateGuard", similarity);
		input.onTier?.({ tier, status: "passed", detail: "degenerateGuard" });
		return true;
	};
}
