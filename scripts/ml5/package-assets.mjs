#!/usr/bin/env node
/**
 * ml5/package-assets.mjs — ML5-C install-matrix + byte-count budget assertion.
 *
 * Assembles the per-platform install matrix for the chosen runtime backend
 * and asserts the operator-configurable install budget (default 300 MiB;
 * HG-3 closure surface) BEFORE publish. The matrix resolves every Node
 * platform to a concrete package/size row — onnxruntime-web for WASM (single
 * package, all platforms), or onnxruntime-(node) with per-platform
 * optionalDependencies for native.
 *
 * Budget rule: the shipped byte-count is compared against
 * `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` (default 300 MiB). At the default,
 * WASM (~9 MiB) and native (~160 MiB across 5 platforms) both fit, so the
 * fixture asserts `byte_count_le_budget: true`. An operator who lowers the
 * budget below the shipped byte-count sees `budgetOk: false` in both the
 * fixture and the runtime selection — the amendment path remains, but it is
 * no longer the default disposition for native.
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

/** The default operator-configurable install budget (MiB). */
const INSTALL_BUDGET_DEFAULT_MIB = 300;
const INSTALL_BUDGET_CLAMP_MIB = 8192;

// Pure resolver mirroring decision.ts::resolveInstallBudgetMib so the script
// (no src/ import) and the runtime share the exact same clamp rule.
export function resolveInstallBudgetMib(raw) {
  if (raw === undefined || raw === null || raw === "") return INSTALL_BUDGET_DEFAULT_MIB;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > INSTALL_BUDGET_CLAMP_MIB) {
    return INSTALL_BUDGET_DEFAULT_MIB;
  }
  return n;
}

/** Returns the operator-configured install budget (MiB) from env, default 300. */
export function installBudgetMib() {
  return resolveInstallBudgetMib(process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB);
}

/** @deprecated use installBudgetMib() — kept for backwards-compat imports. */
export const RUNTIME_NATIVE_INSTALL_BUDGET_MIB = INSTALL_BUDGET_DEFAULT_MIB;

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
 * payload the conformance fixture pins (byte_count_le_budget: true at the
 * default 300 MiB budget for both WASM and native; under an operator-lowered
 * budget, `byte_count_le_budget: false` and `amended_budget_mib` carries the
 * shipped byte-count as the amendment figure). When the shipped bytes fit the
 * configured budget, `amended_budget_mib` is null (no amendment).
 */
export function budgetAssertion(backend, opts = {}) {
  const totalMib = totalByteCountMib(backend, opts);
  const budgetMib = installBudgetMib();
  const within = totalMib <= budgetMib;
  return {
    within_budget: within,
    budget_mib: budgetMib,
    byte_count_mib: totalMib,
    byte_count_le_budget: within,
    amended_budget_mib: within ? null : totalMib,
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
