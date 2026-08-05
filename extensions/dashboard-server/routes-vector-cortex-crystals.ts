/**
 * dashboard-server/routes-vector-cortex-crystals.ts — VC7A frozen-range-crystal
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/cache-crystals returning the crystal
 * store's aggregate diagnostics: whether the flag is enabled, the runtime triad
 * mode, how many crystals are held and at what byte volume, hit/miss/hit-byte
 * counters, write/duplicate/collision counters, and the last CRY_* failure code.
 *
 * COUNTS + BYTES + ERROR CODES ONLY. A crystal is a FROZEN RENDERED PROMPT, so
 * this is the surface where a careless payload field would leak the whole framed
 * conversation. It NEVER exposes frozen bytes, covered ranges, span or covered
 * digests, request digests, session ids, or key digests (reader-only,
 * SECURITY_PRIVACY — per-key detail belongs in the structured event log). There
 * is no mutation seam either: crystals are written by the render path, never by
 * a dashboard request, and the store is write-once by construction, so a
 * dashboard-driven write could not overwrite anything even if it existed.
 * Non-GET is rejected outright.
 *
 * Split into its own file (rather than grown into routes-vector-cortex-repair.ts)
 * to keep every extensions/ file well under the 400-line soft-as-hard limit.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC7A_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { countVcEvents, vcCount } from "./vc-event-counts.js";
import type { VectorCortexCrystalsView } from "./api-contracts/vector-cortex-cache.js";

// Actual events emitted by src/vector-cortex/cache/crystal-emit.ts.
const CRYSTAL_EVENTS = [
  "vector_cortex_crystal_written",
  "vector_cortex_crystal_collision",
] as const;

/**
 * Reader-only GET /api/vector-cortex/cache-crystals (VC7A).
 *
 * Counts, byte volumes, and CRY_* codes only — a static reader-only aggregate
 * seam with the same shape as the VC6A/VC6B/VC6C handlers.
 */
export function handleVectorCortexCrystals(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/cache-crystals") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC7A_ENABLED();
  const counts = countVcEvents(ctx.stateDir, CRYSTAL_EVENTS);
  // Flag-off routes to mode C: with VC7A off nothing is served from the crystal
  // cache, which is exactly the spec's "cache bypass" outcome. Reporting A (hit)
  // or B (fresh render forced by a miss) would imply a cache path that is not
  // wired at all. Mirrors how VC6C's OFF view reports the mode it actually takes.
  const mode: "A" | "B" | "C" = enabled ? "A" : "C";
  const body: VectorCortexCrystalsView = {
    enabled,
    mode,
    crystalCount: vcCount(counts, "vector_cortex_crystal_written"),
    totalBytes: 0,
    hits: 0,
    misses: 0,
    hitBytes: 0,
    writes: 0,
    duplicateWrites: 0,
    collisions: vcCount(counts, "vector_cortex_crystal_collision"),
    lastFailure: null,
    updatedAt: new Date().toISOString(),
    deferredReason: "crystal_store_not_instantiated_v0_20_23",
  };
  sendJson(res, 200, body);
  return true;
}
