/**
 * dashboard-server/routes-vector-cortex-rollout.ts — VC5C live graduated-rollout
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/rollout returning the rollout aggregate:
 * current gate, bucket count, sessions/events counts, and promotion-blocked
 * state. NEVER exposes session payloads, prompt text, or bucket→session mappings
 * (reader-only, SECURITY_PRIVACY). Flag-gated on MEGACOMPACT_VC5C: `enabled:false`
 * when off (byte-identical to the pre-VC5C predecessor).
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + gate state only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteContext } from "./routes-core.js";
import { VC5C_ENABLED } from "../../src/config.js";
import { ROLLOUT_GATES, ROLLOUT_BUCKETS } from "../../src/vector-cortex/rollout/types.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { countVcEvents, vcCount } from "./vc-event-counts.js";
import { deriveVcStatus } from "./vc-status.js";
import type { VectorCortexRolloutView } from "./api-contracts/vector-cortex.js";

// Rollout events: assigned/promotion-blocked from rollout/emit.ts, plus the
// explicit decision event appended by pipelineRun.ts:79 after decideLivePath.
const ROLLOUT_EVENTS = [
  "vector_cortex_rollout_assigned",
  "vector_cortex_rollout_promotion_blocked",
  "vector_cortex_rollout_decision",
] as const;

/** Reader-only GET /api/vector-cortex/rollout (VC5C). */
export function handleVectorCortexRollout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/rollout") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC5C_ENABLED();
  const counts = countVcEvents(ctx.stateDir, ROLLOUT_EVENTS);
  const eventCount =
    vcCount(counts, "vector_cortex_rollout_assigned") +
    vcCount(counts, "vector_cortex_rollout_promotion_blocked") +
    vcCount(counts, "vector_cortex_rollout_decision");
  const sessionCount = enabled ? distinctRolloutSessions(ctx.stateDir) : 0;
  const gateIndex = 0; // Ephemeral rollout state: no durable gate in this sprint.
  const gatePct = ROLLOUT_GATES[gateIndex]!;
  const body: VectorCortexRolloutView = {
    enabled,
    gateIndex: enabled ? gateIndex : 0,
    gatePct: enabled ? gatePct : 0,
    buckets: ROLLOUT_BUCKETS,
    bucketCount: enabled ? gatePct * 100 : 0,
    events: enabled ? eventCount : 0,
    sessions: enabled ? sessionCount : 0,
    promotionBlocked: false,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled, hasData: eventCount > 0 }),
  };
  sendJson(res, 200, body);
  return true;
}

/**
 * Count distinct session ids among rollout_assigned events in the tail of
 * events.log. Best-effort: a missing/unreadable log or malformed lines yield 0.
 * Only the `sessionId` field of rollout_assigned lines is inspected (aggregate
 * only, never session payloads/prompts).
 */
function distinctRolloutSessions(stateDir: string): number {
  const seen = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, "events.log"), "utf-8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  const start = Math.max(0, lines.length - 10000);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length === 0) continue;
    let ev: { event?: unknown; sessionId?: unknown } | null = null;
    try {
      ev = JSON.parse(line) as { event?: unknown; sessionId?: unknown };
    } catch {
      continue;
    }
    if (
      ev?.event === "vector_cortex_rollout_assigned" &&
      typeof ev.sessionId === "string" &&
      ev.sessionId.length > 0
    ) {
      seen.add(ev.sessionId);
    }
  }
  return seen.size;
}
