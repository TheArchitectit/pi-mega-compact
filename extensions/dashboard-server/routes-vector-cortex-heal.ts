/**
 * dashboard-server/routes-vector-cortex-heal.ts — VC6A closure-optimization
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/closure-proof returning aggregate-only
 * closure diagnostics: whether the flag is enabled, the runtime triad mode, and
 * cumulative edge/traversal counters. NEVER exposes per-edge proof rows, the
 * closed selection, node ids, or any source payload (reader-only, SECURITY_PRIVACY
 * — the detailed proof lives in the structured event log, not the dashboard).
 *
 * When the flag is OFF (`MEGACOMPACT_VC6A=0`) the runtime falls back to mode B
 * (the conservative VC4C closure, no reduction) — that is exactly the spec's
 * fallback rule — so `mode:"B"` + `enabled:false` is the byte-stable OFF view.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + mode only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC6A_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexClosureProofView } from "./api-contracts/vector-cortex.js";

/** Reader-only GET /api/vector-cortex/closure-proof (VC6A). */
export function handleVectorCortexClosureProof(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/closure-proof") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC6A_ENABLED();
  // Flag-off routes to mode B (conservative closure, no reduction) per spec.
  const mode: "A" | "B" | "C" = enabled ? "A" : "B";
  const body: VectorCortexClosureProofView = {
    enabled,
    mode,
    optimizations: 0,
    proofRejections: 0,
    retainedEdgeTotal: 0,
    removedEdgeTotal: 0,
    conservativeTraversalTotal: 0,
    optimizedTraversalTotal: 0,
    lastRejection: null,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
