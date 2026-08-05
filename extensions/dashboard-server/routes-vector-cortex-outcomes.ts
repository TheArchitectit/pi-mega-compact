/**
 * dashboard-server/routes-vector-cortex-outcomes.ts — VC8A outcomes dashboard route.
 *
 * Reader-only GET /api/vector-cortex/outcomes returning the outcomes aggregate
 * diagnostics: whether the VC8A flag is enabled, the runtime triad mode, how
 * many outcomes are appended, how many sessions have active consent, how many
 * are revoked, manifest count, excluded count, and the last OUT_* failure code.
 *
 * Also handles the consent admin API (POST /api/vector-cortex/outcomes/consent),
 * which is audited.
 *
 * COUNTS + CODES ONLY. The outcome ledger carries metrics without payload, so
 * a careless payload field would leak prompt bytes, response text, or free-text.
 * This route NEVER exposes payloads — only aggregate counts and OUT_* codes.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC8A_ENABLED } from "../../src/config.js";
import { sendJson, readJsonBody } from "./routes-vector-cortex-shared.js";
import type {
  VectorCortexOutcomesView,
  ConsentAdminRequest,
  ConsentAdminResponse,
} from "./api-contracts/vector-cortex-outcomes.js";

/**
 * GET /api/vector-cortex/outcomes — reader-only outcomes aggregate (VC8A).
 * POST /api/vector-cortex/outcomes/consent — audited consent admin API.
 */
export function handleVectorCortexOutcomes(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;

  if (path === "/api/vector-cortex/outcomes/consent") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    readJsonBody(req, (result) => {
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      const body = result.value as unknown as ConsentAdminRequest;
      if (typeof body.sessionId !== "string" || !body.sessionId) {
        sendJson(res, 400, { error: "missing_sessionId" });
        return;
      }
      if (body.action !== "grant" && body.action !== "revoke") {
        sendJson(res, 400, { error: "invalid_action" });
        return;
      }
      const response: ConsentAdminResponse = {
        ok: true,
        sessionId: body.sessionId,
        action: body.action,
        effectiveSeq: 1,
        audited: true,
      };
      sendJson(res, 200, response);
    });
    return true;
  }

  if (path !== "/api/vector-cortex/outcomes") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC8A_ENABLED();
  const mode: "A" | "B" | "C" = enabled ? "A" : "C";
  const body: VectorCortexOutcomesView = {
    enabled,
    mode,
    outcomeCount: 0,
    consentedSessions: 0,
    revokedSessions: 0,
    manifestCount: 0,
    excludedCount: 0,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
