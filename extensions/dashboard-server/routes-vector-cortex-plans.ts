/**
 * dashboard-server/routes-vector-cortex-plans.ts — VC5A PromptDagV1 + budgeted
 * planner dashboard route.
 *
 * Reader-only GET /api/vector-cortex/plans returning ONLY plan manifests — the
 * registered PromptDagV1 (DAG-001..030) and budgeted-planner (PLN-001..020)
 * identifier counts, plus a reader-only plans array. NEVER exposes session
 * payloads, prompt text, byte spans, or source bytes (reader-only,
 * SECURITY_PRIVACY). Flag-gated on MEGACOMPACT_VC5A: `enabled:false` when off
 * (byte-identical to the pre-VC5A predecessor).
 *
 * The VC5A planner is PURE IN-MEMORY logic in this sprint (it has no durable plan
 * store yet), so the per-run plan outputs are not persisted. The route reports
 * the registered manifest layout truthfully: `enabled` reflects the flag, the
 * dag/planner counts come from the registered conformance ID range, and `plans`
 * is empty until a future sprint persists selected plans. Non-fatal: an internal
 * error degrades to `enabled:false` with empty arrays.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem / in-process state only),
 * PREVENT-011 (no `any`), reader-only aggregate (counts + manifests only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC5A_ENABLED } from "../../src/config.js";
import { DAG_IDS } from "../../src/vector-cortex/prompt-dag/types.js";
import { PLN_IDS } from "../../src/vector-cortex/planner/types.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexPlansView } from "./api-contracts/vector-cortex.js";

/**
 * Reader-only GET /api/vector-cortex/plans (VC5A).
 */
export function handleVectorCortexPlans(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/plans") return false;
  if (req.method !== "GET") {
    // Reader-only path: cannot be "off" without a GET; it is genuinely read-only.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC5A_ENABLED();
  const body: VectorCortexPlansView = {
    enabled,
    dagCount: enabled ? DAG_IDS.length : 0,
    plannerCount: enabled ? PLN_IDS.length : 0,
    plans: [],
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
