/**
 * dashboard-server/routes-vector-cortex.ts — vector-cortex dashboard routes.
 *
 * Delegate shell: each VC feature owns a focused handler module below the
 * extension line limit, and this file re-exports them unchanged so the existing
 * registration (`routes.ts`, `server.ts`) keeps working without modification.
 *
 *   VC0A evaluation  -> routes-vector-cortex-eval.ts  (GET  /evaluation)
 *   VC0C health/reset-> routes-vector-cortex-health.ts(GET  /health, POST /breakers/reset)
 *   VC1B ledger      -> routes-vector-cortex-ledger.ts (GET  /ledger)
 *   VC3A topology    -> routes-vector-cortex-topology.ts(GET /topology)
 *   VC6A closure     -> routes-vector-cortex-heal.ts   (GET  /closure-proof)
 *   VC6B restore     -> routes-vector-cortex-heal.ts   (GET  /restore)
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregates (never payloads/prompts/ledger text).
 */

export { handleVectorCortexEvaluation } from "./routes-vector-cortex-eval.js";
export { handleVectorCortexHealth, handleVectorCortexBreakersReset } from "./routes-vector-cortex-health.js";
export { handleVectorCortexLedger } from "./routes-vector-cortex-ledger.js";
export { handleVectorCortexTopology } from "./routes-vector-cortex-topology.js";
export { handleVectorCortexQuery } from "./routes-vector-cortex-query.js";
export { handleVectorCortexShards } from "./routes-vector-cortex-shards.js";
export { handleVectorCortexResidual } from "./routes-vector-cortex-residual.js";
export { handleVectorCortexReconstruct } from "./routes-vector-cortex-reconstruct.js";
export { handleVectorCortexPlans } from "./routes-vector-cortex-plans.js";
export { handleVectorCortexRender } from "./routes-vector-cortex-render.js";
export { handleVectorCortexRollout } from "./routes-vector-cortex-rollout.js";
export {
	handleVectorCortexClosureProof,
	handleVectorCortexRestore,
} from "./routes-vector-cortex-heal.js";
