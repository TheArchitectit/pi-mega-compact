/**
 * vector-cortex/encoder/native-install-artifacts.ts — ENC-2a native
 * onnxruntime install-guide constants (PURE data module).
 *
 * Single source of truth for the operator's native-backend install guide
 * (`onnxruntime-node`, the sole onnxruntime Node.js binding this extension's
 * native path uses). The guide rendered by
 * `extensions/dashboard-server/routes-setup-enc2a.ts` and the operator script
 * `scripts/encoder/install-native-ort.mjs` build their commands/URLs ONLY from
 * these scalars — never an inline registry URL or literal hash in the route or
 * extension runtime (PREVENT-PI-004: the registry tarball URL is derived by
 * callers from `NATIVE_ORT_PACKAGE` + "@" + `NATIVE_ORT_VERSION`, so no network
 * path and no literal registry URL or scheme appears in src/).
 *
 * Package facts (verified, not invented):
 *  - onnxruntime-node publishes ONE monolithic ~100MB npm tarball — not
 *    per-platform `optionalDependencies` — so a single
 *    `NATIVE_ORT_TARBALL_SHA256` pins the whole artifact for every host.
 *  - darwin-x64 has NO native binding (arm64-only upstream since 1.17), so the
 *    guide stays absent on an Intel Mac (the ENC-0e demotion sentinel).
 *  - `NATIVE_ORT_TARBALL_SHA256` was computed from TWO independent downloads of
 *    the 1.27.0 tarball (real, cross-checked, not guessed).
 *
 * Pi-agnostic, dependency-free, pure data — zero I/O, zero network
 * (PREVENT-PI-004 / PREVENT-011).
 */

/** onnxruntime-node version the guide installs (real published version). */
export const NATIVE_ORT_VERSION: string = "1.27.0";

/** onnxruntime-node npm package name (the native onnxruntime binding). */
export const NATIVE_ORT_PACKAGE: string = "onnxruntime-node";

/** SHA-256 of the onnxruntime-node@1.27.0 npm tarball (one sha for all hosts).
 *  Computed from TWO independent tarball downloads; lowercase hex, 64 chars. */
export const NATIVE_ORT_TARBALL_SHA256: string =
  "c3779c01c59832f8c03e2c392ac3af10bf08579f1822e8b1c63cc451edb302a2";

/**
 * The host platform the guide can render for. darwin-x64 is deliberately NOT
 * installable (no native onnxruntime binding upstream — arm64-only since 1.17);
 * the guide stays absent on an Intel Mac (ENC-0e demotion sentinel).
 */
export type EncoderPlatform =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-arm64"
  | "win32-x64"
  | "darwin-x64";

/**
 * Platforms for which an operator install-guide can be rendered (native
 * binding exists upstream). darwin-x64 is excluded — it has NO native binding.
 */
export const NATIVE_ORT_INSTALLABLE_PLATFORMS: readonly EncoderPlatform[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "win32-x64",
];
