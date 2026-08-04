/**
 * dashboard-client/src/api/vector-cortex.ts — vector-cortex API client.
 * PREVENT-PI-004: relative path only (loopback dashboard).
 */

import type {
	VectorCortexEvaluationSummary,
	VectorCortexHealthCard,
	VectorCortexResetResult,
} from "../types/vector-cortex";

export type {
	VectorCortexEvaluationSummary,
	VectorCortexHealthCard,
	VectorCortexResetResult,
};

export async function fetchVectorCortexEvaluation(): Promise<VectorCortexEvaluationSummary> {
	const r = await fetch("/api/vector-cortex/evaluation");
	if (!r.ok) throw new Error(`vector-cortex evaluation: ${r.status}`);
	return r.json() as Promise<VectorCortexEvaluationSummary>;
}

export async function fetchVectorCortexHealth(): Promise<VectorCortexHealthCard> {
	const r = await fetch("/api/vector-cortex/health");
	if (!r.ok) throw new Error(`vector-cortex health: ${r.status}`);
	return r.json() as Promise<VectorCortexHealthCard>;
}

/** Admin capability: reset a breaker's cooldown (never evidence). */
export async function resetVectorCortexBreaker(
	subsystem: string,
): Promise<VectorCortexResetResult> {
	const r = await fetch("/api/vector-cortex/breakers/reset", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subsystem }),
	});
	if (!r.ok) throw new Error(`vector-cortex reset: ${r.status}`);
	return r.json() as Promise<VectorCortexResetResult>;
}
