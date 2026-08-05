/**
 * dashboard-server/routes-vector-cortex-ledger.ts — VC1B vector-cortex ledger
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/ledger built on the LedgerReader capability:
 * opens the occurrence-v2 ledger for this repo's state dir and returns the
 * session's occurrence IDENTITY rows (seq/eventId/kind/digest/toolCallId) plus
 * high-water/count. NEVER ships sourceBytes or prompt text (reader-only
 * no-ledger-text rule). Optional `?session=<id>` query selects the session.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate/identity only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC1B_ENABLED } from "../../src/config.js";
import { createLedgerStore } from "../../src/vector-cortex/ledger/store.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexLedgerView } from "./api-contracts/vector-cortex.js";
import { deriveVcStatus } from "./vc-status.js";

/**
 * Reader-only GET /api/vector-cortex/ledger (VC1B).
 */
export function handleVectorCortexLedger(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/ledger") return false;
  if (req.method !== "GET") {
    // Reader-only path: no mutation endpoint lives at /ledger.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  // Parse the optional session query parameter.
  let session = "default";
  const qs = url.split("?")[1];
  if (qs !== undefined) {
    for (const pair of qs.split("&")) {
      const [k, v] = pair.split("=");
      if (k === "session" && v !== undefined && v.length > 0) {
        session = decodeURIComponent(v);
      }
    }
  }

  const enabled = VC1B_ENABLED();
  let active = enabled;
  let highWater = "0";
  let count = 0;
  let occurrences: VectorCortexLedgerView["occurrences"] = [];

  if (enabled) {
    try {
      const store = createLedgerStore({ stateDir: ctx.stateDir });
      try {
        const reader = store.reader();
        highWater = reader.highWater(session).toString();
        const rows = reader.readSession(session);
        count = rows.length;
        // Identity only: never sourceBytes or prompt text (reader-only rule).
        occurrences = rows.slice(-500).map((occ) => ({
          seq: occ.seq.toString(),
          eventId: occ.eventId,
          kind: occ.kind,
          digest: occ.digest,
          ...(occ.toolCallId !== undefined ? { toolCallId: occ.toolCallId } : {}),
        }));
      } finally {
        store.close();
      }
    } catch {
      // Non-fatal: a missing/corrupt ledger DB degrades to `enabled:false`.
      active = false;
    }
  }

  const body: VectorCortexLedgerView = {
    enabled: active,
    session,
    highWater,
    count,
    occurrences,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled: active, hasData: count > 0 }),
  };
  sendJson(res, 200, body);
  return true;
}
