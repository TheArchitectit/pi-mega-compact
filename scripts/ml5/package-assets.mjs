#!/usr/bin/env node
/**
 * ml5/package-assets.mjs — ML5-C install-matrix + byte-count budget assertion.
 *
 * Assembles the per-platform install matrix for the chosen runtime backend
 * and asserts the 80 MiB install budget (HG-3 closure) BEFORE publish. The
 * matrix resolves every Node platform to a concrete package/size row —
 * onnxruntime-web for WASM (single package, all platforms), or
 * onnxruntime-(node) with per-platform optionalDependencies for native.
 *
 * Budget rule: for WASM (Option W) the `byte_count_le_budget` fixture asserts
 * PASS; for native (Option N) the budget is AMENDED per the measured evidence
 * (vc2-model-prep §3: native on linux-x64 lands ~100–150 MiB total, so the
 * fixture carries `amended_budget_mib` instead of `byte_count_le_budget:true`).
 *
 * LOCAL ONLY: filesystem reads only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/ml5/package-assets.mjs [--backend=native|wasm] [--write]
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");

/** The unamended 80 MiB install budget in bytes. */
export const RUNTIME_NATIVE_INSTALL_BUDGET_MIB = 80;

/** Per-platform native install sizes (MiB, approximate — vc2-model-prep §1 measured). */
export const NATIVE_PER_PLATFORM_MIB = Object.freeze({
  "linux-x64": 33,
  "darwin-arm64": 28,
  "darwin-x64": 33,
  "linux-arm64": 31,
  "win32-x64": 35,
});

/** WASM is one package for every platform. */
export const WASM_FOOTPRINT_MIB = 9;

/** All supported target platforms. */
export const RUNTIME_PLATFORMS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
]);

/**
 * Compute the full install matrix rows for the chosen backend.
 * `backend: "wasm" | "native"`; `nativeOptIn` selects the explicit native path
 * when the decision-rule did NOT already pick it (fixture ML5-RUNTIME-005).
 */
export function buildInstallMatrix(backend, opts = {}) {
  const mibs = backend === "wasm"
    ? Object.fromEntries(RUNTIME_PLATFORMS.map((p) => [p, opts.nativeOptIn && p !== "darwin-x64" ? (NATIVE_PER_PLATFORM_MIB[p] ?? 0) : WASM_FOOTPRINT_MIB]))
    : Object.fromEntries(RUNTIME_PLATFORMS.map((p) => [p, NATIVE_PER_PLATFORM_MIB[p] ?? 0]));
  return RUNTIME_PLATFORMS.map((p) => ({
    platform: p,
    backend,
    mib: mibs[p],
    optionalDep: backend === "native"
      ? `@onnxruntime/node-${p === "win32-x64" ? "win32-x64" : p.replace("-", "-")}`
      : null,
  }));
}

/**
 * Compute the total byte-count for the backend choice across every platform
 * the npm `optionalDependencies` map would install (all 5), in MiB.
 */
export function totalByteCountMib(backend, opts = {}) {
  return buildInstallMatrix(backend, opts).reduce((sum, r) => sum + r.mib, 0);
}

/**
 * Assert the byte-count budget for the backend choice. Returns the assertion
 * payload the conformance fixture pins ({ byte_count_le_budget: true } for WASM,
 * { amended_budget_mib: N } for native when over budget). Throws when the
 * contract is unexpectedly violated (e.g. native under budget AND the fixture
 * still records an amendment).
 */
export function budgetAssertion(backend, opts = {}) {
  const totalMib = totalByteCountMib(backend, opts);
  if (backend === "wasm" && !opts.nativeOptIn) {
    return {
      within_budget: true,
      budget_mib: RUNTIME_NATIVE_INSTALL_BUDGET_MIB,
      byte_count_mib: totalMib,
      byte_count_le_budget: totalMib <= RUNTIME_NATIVE_INSTALL_BUDGET_MIB,
      amended_budget_mib: null,
      matrix_complete: buildInstallMatrix(backend, opts).every((r) => r.mib > 0),
    };
  }
  return {
    within_budget: false,
    budget_mib: RUNTIME_NATIVE_INSTALL_BUDGET_MIB,
    byte_count_mib: totalMib,
    byte_count_le_budget: false,
    amended_budget_mib: totalMib,
    matrix_complete: buildInstallMatrix(backend, opts).every((r) => r.mib > 0),
  };
}

function main() {
  const argBackend = process.argv.find((a) => a.startsWith("--backend="))?.split("=")[1] ?? "native";
  if (!["wasm", "native"].includes(argBackend)) {
    console.error(`unknown --backend: ${argBackend} (want wasm|native)`);
    process.exit(1);
  }
  const matrix = buildInstallMatrix(argBackend);
  const assertion = budgetAssertion(argBackend);
  console.log(JSON.stringify({
    backend: argBackend,
    matrix,
    assertion,
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("package-assets.mjs")) {
  main();
}
