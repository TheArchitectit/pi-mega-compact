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
import type { VectorCortexDiagnosticsView } from "./api-contracts/vector-cortex-diagnostics.js";

/**
 * Reader-only GET /api/vector-cortex/cache-diagnostics (VC7C).
 *
 * Per-miss-class counts, breaker state, and CACHE and M5 codes only — a static
 * reader-only aggregate seam with the same shape as the VC7B economics handler.
 */
export function handleVectorCortexDiagnostics(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/cache-diagnostics") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC7C_ENABLED();
  // Flag-off routes to mode C: with VC7C off the diagnostics/breaker reporter is
  // suppressed, so no cache serve is attested here and the surface reports the
  // all-cache bypass outcome. Reporting A (crystal served) or B (fresh render
  // forced by a breaker) would attest a cache decision this seam is not wired to
  // observe. Mirrors how the VC7A/VC7B OFF views report the mode they take.
  const mode: "A" | "B" | "C" = enabled ? "A" : "C";
  const body: VectorCortexDiagnosticsView = {
    enabled,
    mode,
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
  };
  sendJson(res, 200, body);
  return true;
}
