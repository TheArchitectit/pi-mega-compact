/**
 * useVectorCortexPoll — extracted from VectorCortexTab to keep the tab under
 * the 400-line soft limit. Fetches all vector-cortex reader views in parallel
 * every 5s; each fetch is best-effort (a failure sets its slice to null/state).
 */
import { useState, useEffect, useCallback } from "react";
import {
	fetchVectorCortexEvaluation,
	fetchVectorCortexHealth,
	fetchVectorCortexLedger,
	fetchVectorCortexQuery,
	fetchVectorCortexReconstruct,
	fetchVectorCortexPlans,
	fetchVectorCortexRender,
	fetchVectorCortexRollout,
	fetchVectorCortexClosureProof,
	fetchVectorCortexRestore,
	fetchVectorCortexRepair,
	fetchVectorCortexCrystals,
	fetchVectorCortexEconomics,
	fetchVectorCortexDiagnostics,
	fetchVectorCortexShards,
	fetchVectorCortexTopology,
	type VectorCortexEvaluationSummary,
	type VectorCortexHealthCard,
	type VectorCortexLedgerView,
	type VectorCortexQueryView,
	type VectorCortexReconstructView,
	type VectorCortexPlansView,
	type VectorCortexRenderView,
	type VectorCortexRolloutView,
	type VectorCortexClosureProofView,
	type VectorCortexRestoreView,
	type VectorCortexRepairView,
	type VectorCortexCrystalsView,
	type VectorCortexEconomicsView,
	type VectorCortexDiagnosticsView,
	type VectorCortexShardsView,
	type VectorCortexTopologyView,
} from "../api/vector-cortex";

export interface VectorCortexPollState {
	loading: boolean;
	error: string | null;
	data: VectorCortexEvaluationSummary | null;
	health: VectorCortexHealthCard | null;
	ledger: VectorCortexLedgerView | null;
	topology: VectorCortexTopologyView | null;
	query: VectorCortexQueryView | null;
	shards: VectorCortexShardsView | null;
	reconstruct: VectorCortexReconstructView | null;
	plans: VectorCortexPlansView | null;
	render: VectorCortexRenderView | null;
	rollout: VectorCortexRolloutView | null;
	closureProof: VectorCortexClosureProofView | null;
	restore: VectorCortexRestoreView | null;
	repair: VectorCortexRepairView | null;
	crystals: VectorCortexCrystalsView | null;
	economics: VectorCortexEconomicsView | null;
	diagnostics: VectorCortexDiagnosticsView | null;
}

export function useVectorCortexPoll(): [
	VectorCortexPollState,
	() => void,
] {
	const [state, setState] = useState<VectorCortexPollState>({
		loading: true,
		error: null,
		data: null,
		health: null,
		ledger: null,
		topology: null,
		query: null,
		shards: null,
		reconstruct: null,
		plans: null,
		render: null,
		rollout: null,
		closureProof: null,
		restore: null,
		repair: null,
		crystals: null,
		economics: null,
		diagnostics: null,
	});

	const poll = useCallback(() => {
		setState((prev) => ({ ...prev, loading: true }));
		fetchVectorCortexEvaluation()
			.then((data) => setState((prev) => ({ ...prev, data, loading: false, error: null })))
			.catch((e: unknown) =>
				setState((prev) => ({
					...prev,
					loading: false,
					error: e instanceof Error ? e.message : String(e),
				})),
			);
		fetchVectorCortexHealth().then((health) => setState((p) => ({ ...p, health }))).catch(() => {});
		fetchVectorCortexLedger().then((ledger) => setState((p) => ({ ...p, ledger }))).catch(() => {});
		fetchVectorCortexTopology().then((topology) => setState((p) => ({ ...p, topology }))).catch(() => {});
		fetchVectorCortexQuery().then((query) => setState((p) => ({ ...p, query }))).catch(() => {});
		fetchVectorCortexShards().then((shards) => setState((p) => ({ ...p, shards }))).catch(() => {});
		fetchVectorCortexReconstruct().then((reconstruct) => setState((p) => ({ ...p, reconstruct }))).catch(() => {});
		fetchVectorCortexPlans().then((plans) => setState((p) => ({ ...p, plans }))).catch(() => {});
		fetchVectorCortexRender().then((render) => setState((p) => ({ ...p, render }))).catch(() => {});
		fetchVectorCortexRollout().then((rollout) => setState((p) => ({ ...p, rollout }))).catch(() => {});
		fetchVectorCortexClosureProof().then((closureProof) => setState((p) => ({ ...p, closureProof }))).catch(() => {});
		fetchVectorCortexRestore().then((restore) => setState((p) => ({ ...p, restore }))).catch(() => {});
		fetchVectorCortexRepair().then((repair) => setState((p) => ({ ...p, repair }))).catch(() => {});
		fetchVectorCortexCrystals().then((crystals) => setState((p) => ({ ...p, crystals }))).catch(() => {});
		fetchVectorCortexEconomics().then((economics) => setState((p) => ({ ...p, economics }))).catch(() => {});
		fetchVectorCortexDiagnostics().then((diagnostics) => setState((p) => ({ ...p, diagnostics }))).catch(() => {});
	}, []);

	useEffect(() => {
		poll();
		const id = setInterval(poll, 5000);
		return () => clearInterval(id);
	}, [poll]);

	return [state, poll];
}
