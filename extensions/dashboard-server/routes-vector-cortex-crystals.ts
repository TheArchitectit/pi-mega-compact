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
import { deriveVcStatus } from "./vc-status.js";
import { readLivewireSnapshot } from "../../src/vector-cortex/livewire/livewire-registry.js";
import type { VectorCortexCrystalsView } from "./api-contracts/vector-cortex-cache.js";

// The flag-off deferred reason, kept byte-identical to the pre-LIVEWIRE
// predecessor (VC7A: `crystal_store_not_instantiated_v0_20_23`).
const DEFERRED_REASON = "crystal_store_not_instantiated_v0_20_23";

/**
 * Reader-only GET /api/vector-cortex/cache-crystals (VC7A).
 *
 * Counts, byte volumes, and CRY_* codes only. With the flag ON it surfaces the
 * LIVEWIRE `CrystalStore` aggregate (live reads/writes/collisions accumulated at
 * runtime); with the flag OFF it returns the byte-identical legacy deferred view
 * (mode C, deferredReason present) so flag-off parity holds.
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
  if (!enabled) {
    // Flag-off parity: byte-identical to the predecessor (mode C + deferred).
    const body: VectorCortexCrystalsView = {
      enabled: false,
      mode: "C",
      crystalCount: 0,
      totalBytes: 0,
      hits: 0,
      misses: 0,
      hitBytes: 0,
      writes: 0,
      duplicateWrites: 0,
      collisions: 0,
      lastFailure: null,
      updatedAt: new Date().toISOString(),
      deferredReason: DEFERRED_REASON,
      status: deriveVcStatus({ enabled: false, hasData: false }),
    };
    sendJson(res, 200, body);
    return true;
  }

  const snap = readLivewireSnapshot(ctx.stateDir);
  const crystal = snap.crystals;
  const hasData = crystal.crystalCount > 0;
  const body: VectorCortexCrystalsView = {
    enabled: true,
    // Surface the store's honest triad mode (B until a hit, A after, C when the
    // store was set unavailable) rather than a hardcoded A.
    mode: crystal.mode,
    crystalCount: crystal.crystalCount,
    totalBytes: crystal.totalBytes,
    hits: crystal.hits,
    misses: crystal.misses,
    hitBytes: crystal.hitBytes,
    writes: crystal.writes,
    duplicateWrites: crystal.duplicateWrites,
    collisions: crystal.collisions,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled: true, hasData }),
  };
  sendJson(res, 200, body);
  return true;
}
