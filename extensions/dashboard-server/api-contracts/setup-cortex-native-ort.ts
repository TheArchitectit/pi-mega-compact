/**
 * api-contracts/setup-cortex-native-ort.ts — ENC-2c native onnxruntime
 * lazy-download INSTALL action contract types.
 *
 * Sibling additive types for the VC9B action driver: POST /api/setup-cortex-action
 * gains the `install-native-ort` action that, when confirmed, performs the
 * pinned-tarball fetch + sha256 verify + npm install in-process (a TypeScript
 * port of scripts/encoder/install-native-ort.mjs — the npm package ships
 * src/dist/extensions but NOT scripts/, so an installed device has no checkout
 * script to spawn), then re-qualifies the binding via the ENC-2b retest path.
 *
 * The retest result shape mirrors `RetestResult` from
 * extensions/dashboard-server/api-contracts/setup.ts (and
 * src/vector-cortex/encoder/native-qualify-retest.ts): { platform, version,
 * verdict, p95Ms, rssMiB, testedAt }. It is declared here rather than imported
 * from src/ so the contract lives wholly in the extensions layer (PREVENT-PI —
 * extensions never import impl internals) and stays self-contained.
 *
 * PREVENT-PI-004: type definitions only, no network code. The install action is
 * a confirm-gated, npm-delegated local subprocess with NO URL literals (registry
 * URL + sha256 live only in native-install-artifacts.ts).
 * PREVENT-011: no `any` type — all types explicit.
 */

import type { SetupCortexActionResult } from "./setup-cortex.js";

/** ENC-2b/ENC-2c: the native onnxruntime qualification retest result (shape
 *  mirror of api-contracts/setup.ts `RetestResult`). Surfaces only platform,
 *  version, verdict, p95/RSS, testedAt — never binding binary contents or model
 *  weights (SECURITY_PRIVACY). */
export interface NativeOrtRetestResult {
  readonly platform: string;
  readonly version: string;
  readonly verdict: "qualified" | "degraded" | "failed";
  readonly p95Ms: number;
  readonly rssMiB: number;
  readonly testedAt: string;
}

/** The action kind union, which now includes the ENC-2c lazy-download install
 *  action (widen source: setup-cortex.ts). */
export type SetupCortexActionKindWithInstall = SetupCortexActionResult["action"];

/** ENC-2c additive fields appended to the setup-cortex action result once the
 *  install subprocess completes (retest ran regardless of install exit code). */
export interface SetupCortexActionResultWithNativeOrt
  extends SetupCortexActionResult {
  /** Fresh ENC-2b qualification retest result after install (null when the
   *  retest could not run / no binding). Present ONLY for install-native-ort. */
  readonly nativeOrtRetestResult?: NativeOrtRetestResult | null;
  /** Effective backend after the retest: "native" when verdict is `qualified`,
   *  otherwise "wasm". Present ONLY for install-native-ort. */
  readonly nativeOrtBackendEffective?: "native" | "wasm";
}
