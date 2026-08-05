/**
 * dashboard-server/routes-vector-cortex-economics.ts — VC7B cache-economics
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/cache-economics returning the cache-
 * economics aggregate diagnostics: whether the VC7B flag is enabled, the runtime
 * triad mode, how many provider profiles carry economics, how many exclusions
 * are proven vs unproven, and the last ECON_* failure code.
 *
 * COUNTS + CODES ONLY. Cache economics price a FROZEN RENDERED PROMPT's reuse,
 * so a careless payload field would leak the frozen bytes, the covered ranges,
 * the span/covered digests, the request digests, or session ids that identify
 * the framed conversation. This route NEVER exposes frozen bytes, ranges,
 * digests, session ids, or request digests — only aggregate counts and the
 * observable ECON_* outcome code (reader-only, SECURITY_PRIVACY). There is no
 * mutation seam: economics are computed by the render path, never by a dashboard
 * request. Non-GET is rejected outright.
 *
 * Split into its own file (rather than grown into routes-vector-cortex-crystals.ts)
 * to keep every extensions/ file well under the 400-line soft-as-hard limit.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC7B_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { deriveVcStatus } from "./vc-status.js";
import type { VectorCortexEconomicsView } from "./api-contracts/vector-cortex-economics.js";

/**
 * Reader-only GET /api/vector-cortex/cache-economics (VC7B).
 *
 * Counts, profile tallies, and ECON_* codes only — a static reader-only
 * aggregate seam with the same shape as the VC7A crystals handler.
 */
export function handleVectorCortexEconomics(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/cache-economics") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC7B_ENABLED();
  // Flag-off routes to mode C: with VC7B off no cache economics are served, which
  // is exactly the spec's "economics bypass" outcome. Reporting A (cached render
  // priced) or B (fresh render priced) would imply an economics path that is not
  // wired at all. Mirrors how VC6C/VC7A OFF views report the mode they take.
  const mode: "A" | "B" | "C" = enabled ? "A" : "C";
  const body: VectorCortexEconomicsView = {
    enabled,
    mode,
    profileCount: 0,
    provenExclusions: 0,
    unprovenExclusions: 0,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
    deferredReason: "economics_not_computed_v0_20_23",
    status: deriveVcStatus({
      enabled,
      deferredReason: "economics_not_computed_v0_20_23",
      hasData: false,
    }),
  };
  sendJson(res, 200, body);
  return true;
}
