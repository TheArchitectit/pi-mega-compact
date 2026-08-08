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
import { readLivewireSnapshot } from "../../src/vector-cortex/livewire/livewire-registry.js";
import type { VectorCortexEconomicsView } from "./api-contracts/vector-cortex-economics.js";

// The flag-off deferred reason, kept byte-identical to the pre-LIVEWIRE
// predecessor (VC7B: `economics_not_computed_v0_20_23`).
const DEFERRED_REASON = "economics_not_computed_v0_20_23";

/**
 * Reader-only GET /api/vector-cortex/cache-economics (VC7B).
 *
 * Counts, profile tallies, and ECON_* codes only. With the flag ON it surfaces
 * the LIVEWIRE-provided profile economics tallies + the runtime `computed` bit;
 * with the flag OFF it returns the byte-identical legacy deferred view (mode C,
 * deferredReason present).
 */
export function handleVectorCortexEconomics(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/cache-economics") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC7B_ENABLED();
  if (!enabled) {
    // Flag-off parity: byte-identical to the predecessor (mode C + deferred).
    const body: VectorCortexEconomicsView = {
      enabled: false,
      mode: "C",
      profileCount: 0,
      provenExclusions: 0,
      unprovenExclusions: 0,
      lastFailure: null,
      updatedAt: new Date().toISOString(),
      deferredReason: DEFERRED_REASON,
      status: deriveVcStatus({ enabled: false, hasData: false }),
    };
    sendJson(res, 200, body);
    return true;
  }

  const econ = readLivewireSnapshot(ctx.stateDir).economics;
  const body: VectorCortexEconomicsView = {
    enabled: true,
    mode: "A",
    profileCount: econ.profileCount,
    provenExclusions: econ.provenExclusions,
    unprovenExclusions: econ.unprovenExclusions,
    lastFailure: econ.lastFailure,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled: true, hasData: econ.computed }),
  };
  sendJson(res, 200, body);
  return true;
}
