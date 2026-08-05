/**
 * dashboard-client/src/api/vector-cortex.ts — vector-cortex API client.
 * PREVENT-PI-004: relative path only (loopback dashboard).
 */

import type {
	VectorCortexEvaluationSummary,
	VectorCortexHealthCard,
	VectorCortexLedgerView,
	VectorCortexPlansView,
	VectorCortexQueryView,
	VectorCortexReconstructView,
	VectorCortexRenderView,
	VectorCortexResetResult,
	VectorCortexRolloutView,
	VectorCortexShardsView,
	VectorCortexTopologyView,
	VectorCortexClosureProofView,
	VectorCortexRestoreView,
	VectorCortexRepairView,
	VectorCortexCrystalsView,
	VectorCortexEconomicsView,
	VectorCortexDiagnosticsView,
	VectorCortexOutcomesView,
	VectorCortexPolicyView,
	VectorCortexPlatformView,
} from "../types/vector-cortex";

export type {
	VectorCortexEvaluationSummary,
	VectorCortexHealthCard,
	VectorCortexLedgerView,
	VectorCortexPlansView,
	VectorCortexQueryView,
	VectorCortexReconstructView,
	VectorCortexRenderView,
	VectorCortexResetResult,
	VectorCortexRolloutView,
	VectorCortexShardsView,
	VectorCortexTopologyView,
	VectorCortexClosureProofView,
	VectorCortexRestoreView,
	VectorCortexRepairView,
	VectorCortexCrystalsView,
	VectorCortexEconomicsView,
	VectorCortexDiagnosticsView,
	VectorCortexOutcomesView,
	VectorCortexPolicyView,
	VectorCortexPlatformView,
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

/** Reader-only plan manifest view (VC5A). Exposes only plan manifests. */
export async function fetchVectorCortexPlans(): Promise<VectorCortexPlansView> {
	const r = await fetch("/api/vector-cortex/plans");
	if (!r.ok) throw new Error(`vector-cortex plans: ${r.status}`);
	return r.json() as Promise<VectorCortexPlansView>;
}

/** Reader-only render + provider-profile view (VC5B). */
export async function fetchVectorCortexRender(): Promise<VectorCortexRenderView> {
	const r = await fetch("/api/vector-cortex/render");
	if (!r.ok) throw new Error(`vector-cortex render: ${r.status}`);
	return r.json() as Promise<VectorCortexRenderView>;
}

/** Reader-only live graduated-rollout view (VC5C). */
export async function fetchVectorCortexRollout(): Promise<VectorCortexRolloutView> {
	const r = await fetch("/api/vector-cortex/rollout");
	if (!r.ok) throw new Error(`vector-cortex rollout: ${r.status}`);
	return r.json() as Promise<VectorCortexRolloutView>;
}

/** Reader-only closure-optimization diagnostics view (VC6A). */
export async function fetchVectorCortexClosureProof(): Promise<VectorCortexClosureProofView> {
	const r = await fetch("/api/vector-cortex/closure-proof");
	if (!r.ok) throw new Error(`vector-cortex closure-proof: ${r.status}`);
	return r.json() as Promise<VectorCortexClosureProofView>;
}

/** Reader-only exact-source-restoration view (VC6B). Counts + codes only. */
export async function fetchVectorCortexRestore(): Promise<VectorCortexRestoreView> {
	const r = await fetch("/api/vector-cortex/restore");
	if (!r.ok) throw new Error(`vector-cortex restore: ${r.status}`);
	return r.json() as Promise<VectorCortexRestoreView>;
}

/** Reader-only self-healing derived-state view (VC6C). Counts + codes only. */
export async function fetchVectorCortexRepair(): Promise<VectorCortexRepairView> {
	const r = await fetch("/api/vector-cortex/repair");
	if (!r.ok) throw new Error(`vector-cortex repair: ${r.status}`);
	return r.json() as Promise<VectorCortexRepairView>;
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

/** Reader-only frozen-crystal cache diagnostics view (VC7A). */
export async function fetchVectorCortexCrystals(): Promise<VectorCortexCrystalsView> {
	const r = await fetch("/api/vector-cortex/cache-crystals");
	if (!r.ok) throw new Error(`vector-cortex cache-crystals: ${r.status}`);
	return r.json() as Promise<VectorCortexCrystalsView>;
}

/** Reader-only cache-economics diagnostics view (VC7B). Counts + codes only. */
export async function fetchVectorCortexEconomics(): Promise<VectorCortexEconomicsView> {
	const r = await fetch("/api/vector-cortex/cache-economics");
	if (!r.ok) throw new Error(`vector-cortex cache-economics: ${r.status}`);
	return r.json() as Promise<VectorCortexEconomicsView>;
}

/** Reader-only cache miss-diagnostics view (VC7C). Counts + codes only. */
export async function fetchVectorCortexDiagnostics(): Promise<VectorCortexDiagnosticsView> {
	const r = await fetch("/api/vector-cortex/cache-diagnostics");
	if (!r.ok) throw new Error(`vector-cortex cache-diagnostics: ${r.status}`);
	return r.json() as Promise<VectorCortexDiagnosticsView>;
}

/** Reader-only consent-bound outcomes aggregate view (VC8A). Counts + codes only. */
export async function fetchVectorCortexOutcomes(): Promise<VectorCortexOutcomesView> {
	const r = await fetch("/api/vector-cortex/outcomes");
	if (!r.ok) throw new Error(`vector-cortex outcomes: ${r.status}`);
	return r.json() as Promise<VectorCortexOutcomesView>;
}

/** Reader-only shadow adaptive policy aggregate view (VC8B). Counts + codes only. */
export async function fetchVectorCortexPolicy(): Promise<VectorCortexPolicyView> {
	const r = await fetch("/api/vector-cortex/policy");
	if (!r.ok) throw new Error(`vector-cortex policy: ${r.status}`);
	return r.json() as Promise<VectorCortexPolicyView>;
}

/** Reader-only engine parity/selection aggregate view (VC8C). Counts + codes only. */
export async function fetchVectorCortexPlatform(): Promise<VectorCortexPlatformView> {
	const r = await fetch("/api/vector-cortex/platform");
	if (!r.ok) throw new Error(`vector-cortex platform: ${r.status}`);
	return r.json() as Promise<VectorCortexPlatformView>;
}
