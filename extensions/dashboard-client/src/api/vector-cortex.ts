/**
 * dashboard-client/src/api/vector-cortex.ts — vector-cortex API client.
 * PREVENT-PI-004: relative path only (loopback dashboard).
 */

import type { VectorCortexEvaluationSummary } from "../types/vector-cortex";

export type { VectorCortexEvaluationSummary };

export async function fetchVectorCortexEvaluation(): Promise<VectorCortexEvaluationSummary> {
	const r = await fetch("/api/vector-cortex/evaluation");
	if (!r.ok) throw new Error(`vector-cortex evaluation: ${r.status}`);
	return r.json() as Promise<VectorCortexEvaluationSummary>;
}
