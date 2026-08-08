/**
 * dashboard-server/setup-cortex-actions-native-ort.ts — ENC-2c native onnxruntime
 * lazy-download INSTALL action driver (actor surface for install-native-ort).
 *
 * Sibling of setup-cortex-actions.ts (which stays under the 300-line source soft
 * cap). Implements the mechanics behind the VC9B `install-native-ort` action:
 *
 *   1. locate the committed scripts/encoder/install-native-ort.mjs by walking up
 *      to the repo root (mirroring setup-cortex-actions.ts vc2ScriptDir);
 *   2. spawn `node <script>` locally with a 60s timeout (npm-delegated,
 *      sha256-verified install — the registry URL + sha256 live ONLY in
 *      src/vector-cortex/encoder/native-install-artifacts.ts, never here);
 *   3. capture output to <stateDir>/logs/vc9b/install-native-ort-<ts>.log;
 *   4. REGARDLESS of the install exit code, re-qualify the binding via the ENC-2b
 *      retest path (`runNativeRetest`) and surface the fresh result +
 *      effective backend.
 *
 * PREVENT-PI-004 banner: this is an OPT-IN, confirm-gated, npm-delegated local
 * subprocess of a committed repo script. It performs no network I/O in this
 * module and carries NO URL literals (the codebase-wide no-URL-literal scan
 * covers src/ + extensions/).
 *
 * Guardrails: PREVENT-011 (no `any`); the subprocess is a committed local script,
 * never fetched (PREVENT-PI-004, guardrails-allow below).
 */

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: opt-in, confirm-gated, npm-delegated install subprocess (local spawn of committed repo script; no URL literals)
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeRetest } from "../../src/vector-cortex/encoder/native-qualify-retest.js";
import type {
  SetupCortexActionResultWithNativeOrt,
  NativeOrtRetestResult,
} from "./api-contracts/setup-cortex-native-ort.js";

/** Locate scripts/encoder/install-native-ort.mjs by walking up to the repo root. */
export function installScriptPath(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("scripts", "encoder", "install-native-ort.mjs");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    // guardrails-allow PREVENT-PI-004: local repo filesystem read (loopback)
    if (existsSync(candidate)) return candidate;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** Ensure the vc9b log dir exists (mirrors setup-cortex-actions.ts). */
function ensureLogDir(stateDir: string): string {
  const dir = join(stateDir, "logs", "vc9b");
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem write (loopback)
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLog(logPath: string, body: string): void {
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem write (loopback)
  writeFileSync(logPath, body, "utf8");
}

/**
 * Run the ENC-2c lazy-download native onnxruntime INSTALL action. Locates and
 * spawns the committed install script (npm-delegated, sha256-verified), logs the
 * captured output, then ALWAYS runs the ENC-2b retest to re-qualify the binding
 * (regardless of install exit code) and surfaces the fresh result.
 *
 * Never throws: a missing script or non-zero exit is surfaced as ok=false on the
 * result; the retest runs even on install failure so the operator sees the
 * post-install qualification state. Returns a combined SetupCortexActionResult
 * with the ENC-2c additive fields (present only for pendant actions).
 */
// guardrails-allow PREVENT-PI-004: opt-in, confirm-gated, npm-delegated install action (subprocess of committed repo script; no URL literals)
export async function runInstallNativeOrt(
  stateDir: string,
): Promise<SetupCortexActionResultWithNativeOrt> {
  const ts = Date.now();
  const logName = `install-native-ort-${ts}.log`;
  const logPath = join(ensureLogDir(stateDir), logName);

  const scriptPath = installScriptPath();
  if (scriptPath === null) {
    writeLog(logPath, "install-native-ort.mjs not found in this checkout\n");
    return {
      action: "install-native-ort",
      ok: false,
      exitCode: null,
      logPath,
      logName,
      spawned: true,
    };
  }

  // guardrails-allow PREVENT-PI-004: opt-in, confirm-gated, npm-delegated
  // install subprocess (local spawn of committed repo script; no URL literals)
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    timeout: 60_000,
  });

  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeLog(logPath, out || "(no output)\n");

  // Re-qualify AFTER install regardless of exit code (the retest is the source of
  // truth for whether the binding is actually usable).
  const retest: NativeOrtRetestResult | null = await runNativeRetest(stateDir);

  return {
    action: "install-native-ort",
    ok: result.status === 0,
    exitCode: result.status === null ? null : result.status,
    logPath,
    logName,
    spawned: true,
    nativeOrtRetestResult: retest,
    nativeOrtBackendEffective: retest !== null && retest.verdict === "qualified" ? "native" : "wasm",
  };
}
