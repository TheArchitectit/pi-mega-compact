/**
 * dashboard-server/routes-vector-cortex-diagnostics.ts — VC7C cache-diagnostics
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/cache-diagnostics returning the cache miss
 * classification aggregate: whether the VC7C flag is enabled, the runtime triad
 * mode, one count per exclusive miss class (profile, range, dependency, request,
 * generation, unknown), how many cache serves the breaker blocked, the breaker
 * state, and the last CACHE/M5 failure code.
 *
 * COUNTS + CODES ONLY. A cache miss diagnostic answers "why did THIS request
 * miss?", so the natural (and forbidden) payload is the request itself: the
 * hashed request bytes, its RequestHashV2 digest, the covered source ranges, the
 * span/covered digests, the provider profile digest, and the session id. This
 * route NEVER exposes any of them — the classification is projected to a count
 * per closed-enumeration class before it reaches the wire (reader-only,
 * SECURITY_PRIVACY). There is no mutation seam: misses are classified and
 * breakers are tripped by the cache serve path, never by a dashboard request,
 * and in particular the breaker can NOT be reset through this route. Non-GET is
 * rejected outright.
 *
 * Split into its own file (rather than grown into routes-vector-cortex-economics.ts)
 * to keep every extensions/ file well under the 400-line soft-as-hard limit.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC7C_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { deriveVcStatus } from "./vc-status.js";
import { readLivewireSnapshot } from "../../src/vector-cortex/livewire/livewire-registry.js";
import type { VectorCortexDiagnosticsView } from "./api-contracts/vector-cortex-diagnostics.js";

// The flag-off deferred reason, kept byte-identical to the pre-LIVEWIRE
// predecessor (VC7C: `cache_classifier_not_wired_v0_20_23`).
const DEFERRED_REASON = "cache_classifier_not_wired_v0_20_23";

/**
 * Reader-only GET /api/vector-cortex/cache-diagnostics (VC7C).
 *
 * Per-miss-class counts, serveBlocked, breaker state, and CACHE/M5 codes only.
 * With the flag ON it surfaces the LIVEWIRE classifier/breaker tallies
 * accumulated at runtime; with the flag OFF it returns the byte-identical legacy
 * deferred view (mode C, deferredReason present).
 */
export function handleVectorCortexDiagnostics(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/cache-diagnostics") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC7C_ENABLED();
  if (!enabled) {
    // Flag-off parity: byte-identical to the predecessor (mode C + deferred).
    const body: VectorCortexDiagnosticsView = {
      enabled: false,
      mode: "C",
      profileMisses: 0,
      rangeMisses: 0,
      dependencyMisses: 0,
      requestMisses: 0,
      generationMisses: 0,
      unknownMisses: 0,
      serveBlocked: 0,
      breakerState: "closed",
      lastFailure: null,
      updatedAt: new Date().toISOString(),
      deferredReason: DEFERRED_REASON,
      status: deriveVcStatus({ enabled: false, hasData: false }),
    };
    sendJson(res, 200, body);
    return true;
  }

  const diag = readLivewireSnapshot(ctx.stateDir).diagnostics;
  const hasData =
    diag.profileMisses +
      diag.rangeMisses +
      diag.dependencyMisses +
      diag.requestMisses +
      diag.generationMisses +
      diag.unknownMisses +
      diag.serveBlocked >
    0;
  const body: VectorCortexDiagnosticsView = {
    enabled: true,
    mode: "A",
    profileMisses: diag.profileMisses,
    rangeMisses: diag.rangeMisses,
    dependencyMisses: diag.dependencyMisses,
    requestMisses: diag.requestMisses,
    generationMisses: diag.generationMisses,
    unknownMisses: diag.unknownMisses,
    serveBlocked: diag.serveBlocked,
    breakerState: diag.breakerState,
    lastFailure: diag.lastFailure,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled: true, hasData }),
  };
  sendJson(res, 200, body);
  return true;
}
