/**
 * dashboard-server/routes-setup-cortex-actions.ts — VC9B Setup Cortex action routes.
 *
 *   POST /api/setup-cortex-action            — confirmation-gated driver
 *   GET  /api/setup-cortex-action-log        — bounded, redacted log tail
 *
 * Reader/actor-only: NEVER exposes payload bytes, prompts, or ledger. Actions
 * only spawn the committed local vc2-model-prep scripts or re-read the committed
 * encoder assets (verify-asset) — no network (PREVENT-PI-004). A hard gate
 * (HG-1/HG-3) blocking the requested action yields 423 action_blocked_by_open_item
 * with the blocker ids and NO subprocess is spawned. Missing confirm:true yields
 * 400 confirmation_required. Flag-off (MEGACOMPACT_VC9B=0) is byte-identical to
 * the VC9A-era predecessor: the routes are absent, so they return the 404
 * disabled shape and no action runs.
 *
 * Guardrails: PREVENT-011 (no `any`), PREVENT-001 (guarded JSON.parse via
 * readJsonBody), no string literals for scripts/blockers (delegated to
 * setup-cortex-actions.ts + setup-cortex-blockers.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { sendJson, readJsonBody } from "./routes-vector-cortex-shared.js";
import { VC9B_ENABLED } from "../../src/config.js";
import { setupCortexActionBlockers } from "./setup-cortex-blockers.js";
import {
  runSetupCortexAction,
  readActionLogTail,
} from "./setup-cortex-actions.js";
import type { SetupCortexActionKind } from "./api-contracts/setup-cortex.js";

const ACTION_KINDS = new Set<SetupCortexActionKind>([
  "fetch-model",
  "bench",
  "verify-asset",
]);

function isActionKind(v: unknown): v is SetupCortexActionKind {
  return typeof v === "string" && ACTION_KINDS.has(v as SetupCortexActionKind);
}

/** Flag-off response, byte-identical regardless of request (VC9B absent). */
function sendDisabled(res: ServerResponse): void {
  sendJson(res, 404, { error: "disabled" });
}

/**
 * POST /api/setup-cortex-action (VC9B). Returns true when it claims the request.
 */
export function handleSetupCortexAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/setup-cortex-action") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!VC9B_ENABLED()) {
    sendDisabled(res);
    return true;
  }
  readJsonBody(req, (parsed) => {
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body" });
      return;
    }
    const value = parsed.value;
    const action = value.action;
    if (!isActionKind(action)) {
      sendJson(res, 400, { error: "invalid_action" });
      return;
    }
    if (value.confirm !== true) {
      sendJson(res, 400, { error: "confirmation_required" });
      return;
    }
    // Hard-gate check: when an OPEN hard-gate item gates this action, do NOT
    // spawn — surface the blocker ids so the client highlights the matching rows.
    const blockers = setupCortexActionBlockers(action);
    if (blockers.length > 0) {
      sendJson(res, 423, {
        error: "action_blocked_by_open_item",
        blockers: [...blockers],
      });
      return;
    }
    const result = runSetupCortexAction(action, ctx.stateDir);
    sendJson(res, result.ok ? 200 : 500, result);
  });
  return true;
}

/**
 * GET /api/setup-cortex-action-log?name=<basename> (VC9B). Returns true when it
 * claims the request. Bounded tail (8 KiB max) + redacted (digest prefixes +
 * codes); the name must validate to a basename inside the vc9b log dir.
 */
export function handleSetupCortexActionLog(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url.split("?")[0] !== "/api/setup-cortex-action-log") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!VC9B_ENABLED()) {
    sendDisabled(res);
    return true;
  }
  let name: string | null = null;
  try {
    name = new URL(url, "http://localhost").searchParams.get("name");
  } catch {
    name = null;
  }
  if (!name) {
    sendJson(res, 400, { error: "invalid_log_name" });
    return true;
  }
  const tail = readActionLogTail(ctx.stateDir, name);
  if (tail === null) {
    sendJson(res, 404, { error: "log_not_found" });
    return true;
  }
  sendJson(res, 200, tail);
  return true;
}
