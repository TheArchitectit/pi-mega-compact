/**
 * dashboard-client/src/api/vector-cortex.ts — vector-cortex API client.
 * PREVENT-PI-004: relative path only (loopback dashboard).
 */

import type {
	VectorCortexEvaluationSummary,
	VectorCortexHealthCard,
	VectorCortexLedgerView,
	VectorCortexQueryView,
	VectorCortexReconstructView,
	VectorCortexResetResult,
	VectorCortexShardsView,
	VectorCortexTopologyView,
} from "../types/vector-cortex";

export type {
	VectorCortexEvaluationSummary,
	VectorCortexHealthCard,
	VectorCortexLedgerView,
	VectorCortexQueryView,
	VectorCortexReconstructView,
	VectorCortexResetResult,
	VectorCortexShardsView,
	VectorCortexTopologyView,
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

/** Reader-only cortex topology view (VC3A). */
export async function fetchVectorCortexTopology(): Promise<VectorCortexTopologyView> {
	const r = await fetch("/api/vector-cortex/topology");
	if (!r.ok) throw new Error(`vector-cortex topology: ${r.status}`);
	return r.json() as Promise<VectorCortexTopologyView>;
}

/** Reader-only query-layer diagnostics view (VC3C). */
export async function fetchVectorCortexQuery(): Promise<VectorCortexQueryView> {
	const r = await fetch("/api/vector-cortex/query");
	if (!r.ok) throw new Error(`vector-cortex query: ${r.status}`);
	return r.json() as Promise<VectorCortexQueryView>;
}

/** Reader-only dual-tier shard aggregate (VC4A). */
export async function fetchVectorCortexShards(): Promise<VectorCortexShardsView> {
	const r = await fetch("/api/vector-cortex/shards");
	if (!r.ok) throw new Error(`vector-cortex shards: ${r.status}`);
	return r.json() as Promise<VectorCortexShardsView>;
}

/** Reader-only reconstruction-fidelity aggregate (VC4C). */
export async function fetchVectorCortexReconstruct(): Promise<VectorCortexReconstructView> {
	const r = await fetch("/api/vector-cortex/reconstruct");
	if (!r.ok) throw new Error(`vector-cortex reconstruct: ${r.status}`);
	return r.json() as Promise<VectorCortexReconstructView>;
}

/** Reader-only occurrence-ledger identity view (VC1B). */
export async function fetchVectorCortexLedger(
	session = "default",
): Promise<VectorCortexLedgerView> {
	const r = await fetch(
		`/api/vector-cortex/ledger?session=${encodeURIComponent(session)}`,
	);
	if (!r.ok) throw new Error(`vector-cortex ledger: ${r.status}`);
	return r.json() as Promise<VectorCortexLedgerView>;
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
