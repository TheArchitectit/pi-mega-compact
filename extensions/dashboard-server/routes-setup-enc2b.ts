/**
 * dashboard-server/routes-setup-enc2b.ts — ENC-2b native onnxruntime
 * qualification retest (reader-only probe) + POST retest action.
 *
 * Extracted out of routes-setup.ts (which hovers at the 300-line source soft
 * cap, mirroring the ENC-1b/ENC-2a sibling extracts) so the ENC-2b additive
 * GET field — the native qualification retest result + effective backend —
 * lives in a sibling impl file and routes-setup.ts stays a thin host.
 *
 * The retest's job is RE-QUALIFICATION: when the operator installed
 * onnxruntime-node via the ENC-2a guide, the encoder read path does not
 * automatically re-evaluate the qualification verdict. This sibling surface
 * runs `runNativeRetest` (a bounded, reader-only, local probe) and:
 *
 *   - surfaces `nativeOrtRetestResult` + `nativeOrtBackendEffective` on the GET
 *     when the flag is on AND a binding is installed — absent otherwise
 *     (byte-identical to the ENC-2a-era shape on flag-off/none);
 *   - handles the POST `nativeOrtRetest` key (`false` → 400
 *     `retest_rejected_false_nothing_to_do`; `true` → run + echo the fresh
 *     result; flag-off → the key is unrecognized, byte-identical predecessor).
 *
 * `nativeOrtBackendEffective` is `"native"` only when the retest verdict is
 * `qualified`; any `degraded`/`failed` verdict keeps the backend `"wasm"` — the
 * runtime never silently switches to a backend whose retest failed.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem + in-process binding load only,
 * zero network — the retest NEVER fetches), PREVENT-011 (no `any`).
 */

import { ENC_2B_ENABLED } from "../../src/config/vector-cortex.js";
import {
  runNativeRetest,
  type RetestResult,
} from "../../src/vector-cortex/encoder/native-qualify-retest.js";
import type { SetupConfigureRequest } from "./api-contracts/setup.js";

/**
 * Resolve the ENC-2b additive GET fields. Returns BOTH fields when the flag is
 * on AND a native binding is installed (the retest ran); returns `{}` on
 * flag-off AND when no binding is installed — both fields are OMITTED (absent,
 * not null), so the GET stays byte-identical to the ENC-2a-era shape and the
 * client hides the retest card. Flag-off omits, never nulls: the ENC-2a-era
 * host spreads `...{}` so no new key appears. Mirror of the ENC-2a/ENC-1b
 * sibling idiom; async because the retest loads the binding in-process.
 */
export async function readEnc2bRetest(stateDir: string): Promise<{
  nativeOrtRetestResult?: RetestResult;
  nativeOrtBackendEffective?: "native" | "wasm";
}> {
  if (!ENC_2B_ENABLED()) return {};
  const result = await runNativeRetest(stateDir);
  if (result === null) return {};
  return {
    nativeOrtRetestResult: result,
    nativeOrtBackendEffective: result.verdict === "qualified" ? "native" : "wasm",
  };
}

/**
 * ENC-2b POST retest-action key handling (flag-gated, additive).
 *
 * `true`  → { action: "run" } (the host runs the retest and returns the result)
 * `false` → { action: "reject" } (400 `retest_rejected_false_nothing_to_do`)
 * other   → null (key absent or flag off — falls through unrecognized,
 *            byte-identical ENC-2a-era predecessor).
 */
export function enc2bRetestRequest(body: SetupConfigureRequest): "run" | "reject" | null {
  if (!ENC_2B_ENABLED()) return null;
  if (body.nativeOrtRetest === true) return "run";
  if (body.nativeOrtRetest === false) return "reject";
  return null;
}

/**
 * Run the ENC-2b retest now (bounded, synchronous on the request) and return
 * the fresh result. Flag-off or no binding → null. Used by the POST "run"
 * branch; the result is returned on the response body, never persisted.
 */
export async function runEnc2bRetest(stateDir: string): Promise<RetestResult | null> {
  if (!ENC_2B_ENABLED()) return null;
  return runNativeRetest(stateDir);
}
