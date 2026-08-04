/**
 * dashboard-server/routes-vector-cortex-query.ts — VC3C vector-cortex query-layer
 * diagnostics dashboard route.
 *
 * Reader-only GET /api/vector-cortex/query. Purely a flag-status + structural
 * diagnostic: the VC3C query index is in-memory (not durable), so this route
 * reports whether the VC3C flag is enabled, the router-generation v2 version
 * constant, and a snapshot timestamp. It NEVER exposes payloads or prompts.
 * Non-fatal: a missing state dir (or any internal error) degrades to
 * `enabled:false`.
 *
 * Guardrails: PREVENT-PI-004 (local flag/config read only, no network),
 * PREVENT-011 (no `any`), reader-only aggregate (never payloads/prompts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC3C_ENABLED } from "../../src/config.js";
import { ROUTER_KEY_VERSION } from "../../src/vector-cortex/topology/query.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexQueryView } from "./api-contracts/vector-cortex.js";

/**
 * Reader-only GET /api/vector-cortex/query (VC3C query-layer diagnostics).
 */
export function handleVectorCortexQuery(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/query") return false;
  if (req.method !== "GET") {
    // Reader-only path: no mutation endpoint lives at /query.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  let enabled = false;
  try {
    enabled = VC3C_ENABLED();
  } catch {
    // Non-fatal: a missing/unavailable flag degrades to `enabled:false`.
    enabled = false;
  }
  const body: VectorCortexQueryView = {
    enabled,
    routerVersion: ROUTER_KEY_VERSION,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
