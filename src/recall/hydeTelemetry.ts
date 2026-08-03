/**
 * recall/hydeTelemetry.ts — pure builder for HydeInvocationInfo.
 *
 * No I/O, no logging: turns a HyDE outcome + hit counts into the
 * serialization-safe telemetry object surfaced on RecallInjectResult.
 */
import type { HydeInvocationInfo } from "./types.js";

export type HydeOutcome = "ran" | "disabled" | "no-llm" | "generation-failed";

export function buildHydeInfo(
	outcome: HydeOutcome,
	hypotheticalDoc: string,
	generationMs: number,
	rawHitCount: number,
	hydeHitCount: number,
	fusedHitCount: number,
): HydeInvocationInfo {
	const ran = outcome === "ran";
	const skipped = !ran;
	// Lift = fusedHitCount / max(1, rawHitCount) — how much HyDE changed recall
	// breadth. Skipped passes yield 1 (raw hits cascade unchanged) unless there
	// were no raw hits to compare against.
	const lift = fusedHitCount / Math.max(1, rawHitCount);
	return {
		ran,
		skipped,
		reason: outcome,
		hypotheticalDoc,
		generationMs: ran ? generationMs : 0,
		rawHitCount,
		hydeHitCount: ran ? hydeHitCount : 0,
		fusedHitCount,
		lift: Math.round(lift * 100) / 100,
	};
}

export function hydeSkipped(
	reason: "disabled" | "no-llm" | "generation-failed",
	rawHitCount: number,
	fusedHitCount: number,
): HydeInvocationInfo {
	return buildHydeInfo(reason, "", 0, rawHitCount, 0, fusedHitCount);
}
