/**
 * dashboard-server/route-dispatch.ts — extracted from server.ts.
 *
 * The dispatch chain: each handler returns true if it ended the response.
 * Extracted to keep server.ts under the 400-line extension soft limit
 * (delegate-shell pattern: server.ts calls this and handles the static fallback).
 *
 * PREVENT-PI-004: local filesystem read only, no network.
 * PREVENT-011: no `any` type.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";

import {
	handleIndex,
	handleRepoIndex,
	handleEvents,
	handleGameState,
	handleGameScores,
	handlePerfSamples,
	handlePerf,
	handleAchievements,
	handleSessions,
	handleTopics,
	handleTurns,
	handleMaintenance,
	handleProviderCache,
	handleMemoryStatus,
	handleCacheStripes,
	handlePrefixStability,
	handleSetupStatus,
	handleSetupDetect,
	handleSetupConfigure,
	handleMemoryMap,
	handleRaptorTree,
	handleRaptorBuildHistory,
	handleContextHealth,
	handleCachePoison,
	handleHealthSettings,
	handleEmbedderHealth,
	handleRagSettings,
	handleRagMetrics,
	handleModelThresholds,
	handleWiki,
	handleVectorCortexEvaluation,
	handleVectorCortexHealth,
	handleVectorCortexBreakersReset,
	handleVectorCortexLedger,
	handleVectorCortexTopology,
	handleVectorCortexQuery,
	handleVectorCortexShards,
	handleVectorCortexResidual,
	handleVectorCortexReconstruct,
	handleVectorCortexPlans,
	handleVectorCortexRender,
	handleVectorCortexRollout,
	handleVectorCortexClosureProof,
	handleVectorCortexRestore,
	handleSetupCortexStatus,
	handleSetupCortexAction,
	handleSetupCortexActionLog,
	handleImproveCortex,
	handleImproveCortexStatus,
	handleDedupTierAttribution,
	handleCosineFpReport,
} from "./routes.js";
// VC6C repair lives in its own module (routes-vector-cortex-repair.ts) so the
// heal route file stays well under the 400-line extension soft limit.
import { handleVectorCortexRepair } from "./routes-vector-cortex-repair.js";
// VC7A frozen-range crystals likewise get their own module so the cache seam
// stays independent of the heal/repair handlers and every file stays well under
// the 400-line extension limit.
import { handleVectorCortexCrystals } from "./routes-vector-cortex-crystals.js";
// VC7B cache economics likewise get their own module so the economics seam stays
// independent of the crystals handler and every file stays well under the
// 400-line extension soft limit.
import { handleVectorCortexEconomics } from "./routes-vector-cortex-economics.js";
// VC7C cache miss diagnostics + breakers gets its own module so the
// diagnostics seam stays independent of economics and every file stays well
// under the 400-line extension soft limit.
import { handleVectorCortexDiagnostics } from "./routes-vector-cortex-diagnostics.js";
// VC8A consent-bound outcome ledger + offline learning dataset gets its own
// module so the outcomes/consent seam stays independent of diagnostics and
// every file stays well under the 400-line extension soft limit.
import { handleVectorCortexOutcomes } from "./routes-vector-cortex-outcomes.js";

// VC8B shadow adaptive policy + M7 pressure-v2 gets its own module so the
// policy/shadow seam stays independent and every file stays well under the
// 400-line extension soft limit.
import { handleVectorCortexPolicy } from "./routes-vector-cortex-policy.js";

// VC8C canary selection + external Rust parity gets its own module so the
// platform/selection seam stays independent and every file stays well under
// the 400-line extension soft limit.
import { handleVectorCortexPlatform } from "./routes-vector-cortex-platform.js";

/**
 * Dispatch a request through every registered route handler.
 * Returns true if a handler claimed the request (ended the response).
 */
export function dispatchRoutes(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (handleIndex(req, res, ctx)) return true;
	if (handleRepoIndex(req, res, ctx)) return true;
	if (handleEvents(req, res, ctx)) return true;
	if (handleGameState(req, res, ctx)) return true;
	if (handleGameScores(req, res, ctx)) return true;
	if (handlePerfSamples(req, res, ctx)) return true;
	if (handlePerf(req, res, ctx)) return true;
	if (handleAchievements(req, res, ctx)) return true;
	if (handleSessions(req, res, ctx)) return true;
	if (handleTopics(req, res, ctx)) return true;
	if (handleTurns(req, res, ctx)) return true;
	if (handleMaintenance(req, res, ctx)) return true;
	if (handleProviderCache(req, res, ctx)) return true;
	if (handleMemoryStatus(req, res, ctx)) return true;
	if (handleCacheStripes(req, res, ctx)) return true;
	if (handlePrefixStability(req, res, ctx)) return true;
	if (handleSetupStatus(req, res, ctx)) return true;
	if (handleSetupDetect(req, res, ctx)) return true;
	if (handleSetupConfigure(req, res, ctx)) return true;
	if (handleMemoryMap(req, res, ctx)) return true;
	if (handleRaptorTree(req, res, ctx)) return true;
	if (handleRaptorBuildHistory(req, res, ctx)) return true;
	if (handleContextHealth(req, res, ctx)) return true;
	if (handleCachePoison(req, res, ctx)) return true;
	if (handleHealthSettings(req, res, ctx)) return true;
	if (handleEmbedderHealth(req, res, ctx)) return true;
	if (handleRagSettings(req, res, ctx)) return true;
	if (handleRagMetrics(req, res, ctx)) return true;
	if (handleModelThresholds(req, res, ctx)) return true;
	if (handleWiki(req, res, ctx)) return true;
	if (handleVectorCortexEvaluation(req, res, ctx)) return true;
	if (handleVectorCortexHealth(req, res, ctx)) return true;
	if (handleVectorCortexBreakersReset(req, res, ctx)) return true;
	if (handleVectorCortexLedger(req, res, ctx)) return true;
	if (handleVectorCortexTopology(req, res, ctx)) return true;
	if (handleVectorCortexQuery(req, res, ctx)) return true;
	if (handleVectorCortexShards(req, res, ctx)) return true;
	if (handleVectorCortexResidual(req, res, ctx)) return true;
	if (handleVectorCortexReconstruct(req, res, ctx)) return true;
	if (handleVectorCortexPlans(req, res, ctx)) return true;
	if (handleVectorCortexRender(req, res, ctx)) return true;
	if (handleVectorCortexRollout(req, res, ctx)) return true;
	if (handleVectorCortexClosureProof(req, res, ctx)) return true;
	if (handleVectorCortexRestore(req, res, ctx)) return true;
	if (handleVectorCortexRepair(req, res, ctx)) return true;
	if (handleVectorCortexCrystals(req, res, ctx)) return true;
	if (handleVectorCortexEconomics(req, res, ctx)) return true;
	if (handleVectorCortexDiagnostics(req, res, ctx)) return true;
	if (handleVectorCortexOutcomes(req, res, ctx)) return true;
	if (handleVectorCortexPolicy(req, res, ctx)) return true;
	if (handleVectorCortexPlatform(req, res, ctx)) return true;
	if (handleSetupCortexStatus(req, res, ctx)) return true;
	if (handleSetupCortexAction(req, res, ctx)) return true;
	if (handleSetupCortexActionLog(req, res, ctx)) return true;
	if (handleImproveCortex(req, res, ctx)) return true;
	if (handleImproveCortexStatus(req, res, ctx)) return true;
	if (handleDedupTierAttribution(req, res, ctx)) return true;
	if (handleCosineFpReport(req, res, ctx)) return true;
	return false;
}
