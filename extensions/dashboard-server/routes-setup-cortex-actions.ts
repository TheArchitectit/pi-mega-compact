/**
 * dashboard-server/routes-setup-cortex-actions.ts — VC9B Setup Cortex action routes.
 *
 *   POST /api/setup-cortex-action            — confirmation-gated driver
 *   GET  /api/setup-cortex-action-log        — bounded, redacted log tail
 *
 * Reader/actor-only: NEVER exposes payload bytes, prompts, or ledger. Actions
 * run in-process (fetch-model via HTTPS, bench via ONNX), re-read the committed
 * encoder assets (verify-asset), or — ENC-2c — run the confirm-gated npm-delegated
 * native onnxruntime install (install-native-ort) + re-qualify — no subprocess
 * spawn for fetch-model/bench (PREVENT-PI-004 opt-in for fetch-model HTTPS).
 * A hard gate (HG-1/HG-3) blocking the requested
 * action yields 423 action_blocked_by_open_item with the blocker ids and the
 * action does NOT execute. Missing confirm:true yields 400 confirmation_required.
 * Flag-off (MEGACOMPACT_VC9B=0) is byte-identical to the VC9A-era predecessor:
 * the routes are absent, so they return the 404 disabled shape and no action runs.
 *
 * Guardrails: PREVENT-011 (no `any`), PREVENT-001 (guarded JSON.parse via
 * readJsonBody), no string literals for scripts/blockers (delegated to
 * setup-cortex-actions.ts + setup-cortex-blockers.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "./routes-core.js";
import { sendJson, readJsonBody } from "./routes-vector-cortex-shared.js";
import {
  VC9B_ENABLED,
  ENC_0G_ENABLED,
  ENC_0F_ENABLED,
  ENC_2C_ENABLED,
} from "../../src/config.js";
import { setupCortexActionBlockers, computeSetupCortexBlockers } from "./setup-cortex-blockers.js";
import { readEncoderManifest, detectPlatform } from "../../src/vector-cortex/encoder/asset.js";
import {
  readQualificationRecord,
  encoderStateDir,
} from "./qualification-record.js";
import { readEnc2aGuide } from "./routes-setup-enc2a.js";
import {
  runSetupCortexAction,
  readActionLogTail,
} from "./setup-cortex-actions.js";
import type { SetupCortexActionKind } from "./api-contracts/setup-cortex.js";

const ACTION_KINDS = new Set<SetupCortexActionKind>([
  "fetch-model",
  "bench",
  "verify-asset",
  "install-native-ort",
]);

function isActionKind(v: unknown): v is SetupCortexActionKind {
  return typeof v === "string" && ACTION_KINDS.has(v as SetupCortexActionKind);
}

/** The encoder asset dir used by the action gate (mirrors routes-setup-cortex.ts). */
function encoderAssetDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("assets", "vector-cortex", "encoder-v1");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/**
 * ENC-0g: the live computed blockers for the action gate. When both gates are
 * ON, read the QualificationV1 record + verified manifest head-count and derive
 * the live list (so a closed HG-1 no longer gates fetch-model/bench). Otherwise
 * return null and let setupCortexActionBlockers fall back to the static base.
 */
function liveActionBlockers(): ReturnType<typeof computeSetupCortexBlockers> | null {
  if (!ENC_0G_ENABLED() || !ENC_0F_ENABLED()) return null;
  const record = readQualificationRecord(encoderStateDir());
  let headCount: number | null = null;
  const dir = encoderAssetDir();
  if (dir !== null) {
    const manifest = readEncoderManifest(dir);
    if (manifest !== null) headCount = Object.keys(manifest.heads).length;
  }
  return computeSetupCortexBlockers({
    platform: detectPlatform(),
    qualification: record,
    headCount,
    // ENC-2c: the install action's HG-3 gate closes when the native binding is
    // installed on this device. The action would be a no-op without this — a
    // stale "open" HG-3 permanently blocks the install button even after the
    // binding is on disk, because the compute default is nativeOrtInstalledVersion
    // = null (not installed). Read the ENC-2a guide probe to get the true state.
    nativeOrtInstalledVersion: readEnc2aGuide(encoderStateDir()).installedVersion,
  });
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
    // ENC-2c: install-native-ort is recognized ONLY while ENC_2C is on —
    // flag-off is byte-identical to the ENC-2b predecessor (invalid_action).
    if (!isActionKind(action) || (action === "install-native-ort" && !ENC_2C_ENABLED())) {
      sendJson(res, 400, { error: "invalid_action" });
      return;
    }
    if (value.confirm !== true) {
      sendJson(res, 400, { error: "confirmation_required" });
      return;
    }
    // Hard-gate check: when an OPEN hard-gate item gates this action, do NOT
    // spawn — surface the blocker ids so the client highlights the matching rows.
    // ENC-0g: re-derive against the LIVE computed blockers (a closed HG-1 no
    // longer blocks), falling back to the static base when the gates are off.
    const live = liveActionBlockers();
    const blockers = live !== null ? setupCortexActionBlockers(action, live) : setupCortexActionBlockers(action);
    if (blockers.length > 0) {
      sendJson(res, 423, {
        error: "action_blocked_by_open_item",
        blockers: [...blockers],
      });
      return;
    }
    void (async () => {
      const result = await runSetupCortexAction(action, ctx.stateDir);
      sendJson(res, result.ok ? 200 : 500, result);
    })();
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
