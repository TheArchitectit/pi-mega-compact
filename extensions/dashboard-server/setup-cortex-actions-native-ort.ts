/**
 * dashboard-server/setup-cortex-actions-native-ort.ts — ENC-2c native onnxruntime
 * lazy-download INSTALL action driver (actor surface for install-native-ort).
 *
 * Sibling of setup-cortex-actions.ts (which stays under the 300-line source soft
 * cap). Implements the mechanics behind the VC9B `install-native-ort` action:
 *
 *   1. compute the install root (`MEGACOMPACT_NATIVE_ORT_ROOT` override, else
 *      default ~/.pi/mega-compact/native-ort);
 *   2. detect the host platform and reject non-installable hosts (ENC-0e);
 *   3. fetch the pinned onnxruntime-node tarball via the operator's npm and
 *      verify its sha256 BEFORE install (the tarball never lands in the final
 *      prefix until the pinned sha matches);
 *   4. `npm install --prefix <root> <tarball>` from the VERIFIED local tarball;
 *   5. write a small `.enc2a-marker.json` marker ({platform, version, sha256})
 *      the ENC-2a version probe reads;
 *   6. REGARDLESS of install exit code, re-qualify the binding via the ENC-2b
 *      retest path (`runNativeRetest`) and surface the fresh result + effective
 *      backend.
 *
 * PREVENT-PI-004 banner: this is an OPT-IN, confirm-gated, npm-delegated local
 * subprocess of a committed repo script. It performs no network I/O in this
 * module and carries NO URL literals (the codebase-wide no-URL-literal scan
 * covers src/ + extensions/).
 *
 * In-process port of scripts/encoder/install-native-ort.mjs: the npm package
 * ships src/ + dist/ + extensions/ but NOT scripts/, so the dashboard button on
 * an installed device has no checkout script to spawn — porting the install
 * logic here keeps the action working independent of the checkout layout.
 *
 * Guardrails: PREVENT-011 (no `any`); PREVENT-PI-004 (npm-delegated local
 * subprocess; guardrails-allow below).
 */

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: opt-in, confirm-gated, npm-delegated install subprocess (local spawn of committed npm tooling; no URL literals)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeRetest } from "../../src/vector-cortex/encoder/native-qualify-retest.js";
import {
  NATIVE_ORT_PACKAGE,
  NATIVE_ORT_TARBALL_SHA256,
  NATIVE_ORT_VERSION,
  NATIVE_ORT_INSTALLABLE_PLATFORMS,
  type EncoderPlatform,
} from "../../src/vector-cortex/encoder/native-install-artifacts.js";
import type {
  SetupCortexActionResultWithNativeOrt,
  NativeOrtRetestResult,
} from "./api-contracts/setup-cortex-native-ort.js";

/** Candidate install roots: `MEGACOMPACT_NATIVE_ORT_ROOT` override first
 *  (ENC-2a parity + test isolation), else the default `~/.pi/mega-compact/
 *  native-ort/`. */
function nativeOrtDir(): string {
  const override = process.env.MEGACOMPACT_NATIVE_ORT_ROOT;
  if (override !== undefined && override.length > 0) return override;
  return join(process.env.HOME ?? "", ".pi", "mega-compact", "native-ort");
}

/** Resolve the host to an installable EncoderPlatform string. darwin-x64 is
 *  UNSUPPORTED (no native binding upstream — arm64-only since 1.17) and
 *  unknown platforms also fail → the caller surfaces a clear failure. */
function hostPlatform(): EncoderPlatform | null {
  const plat =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : "";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
  const candidate = `${plat}-${arch}` as EncoderPlatform;
  if (candidate === "darwin-x64") return null; // no native binding upstream
  if (!NATIVE_ORT_INSTALLABLE_PLATFORMS.includes(candidate)) return null;
  return candidate;
}

/** sha256 digest of a file on disk. Local FS read (loopback). */
function sha256File(path: string): string {
  // guardrails-allow PREVENT-PI-004: local file hash (loopback)
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Write the small `.enc2a-marker.json` marker the ENC-2a version probe reads. */
function writeMarker(root: string, platform: EncoderPlatform): void {
  const marker = {
    platform,
    version: NATIVE_ORT_VERSION,
    installedAt: new Date().toISOString(),
    sha256: NATIVE_ORT_TARBALL_SHA256,
  };
  // guardrails-allow PREVENT-PI-004: local marker write (loopback)
  writeFileSync(
    join(root, ".enc2a-marker.json"),
    JSON.stringify(marker, null, 2) + "\n",
    "utf8",
  );
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

/** The original committed-install-script path lookup, kept for the unit test
 *  that proves the committed scripts/encoder/install-native-ort.mjs lives on
 *  disk in a checkout. The install action itself no longer spawns that script
 *  (in-process port), but the suite would otherwise need to lose that
 *  verification. */
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

/**
 * Run the ENC-2c lazy-download native onnxruntime INSTALL action. Fetches the
 * pinned tarball via the operator's npm, verifies its sha256, installs into
 * `nativeOrtDir()`, then ALWAYS runs the ENC-2b retest to re-qualify the
 * binding and surfacing the fresh result.
 *
 * Never throws: every failure (host platform, npm failure, hash mismatch)
 * surfaces as ok=false on the result; the retest runs even on install failure
 * so the operator sees the post-install qualification state. Returns a
 * combined SetupCortexActionResult with the ENC-2c additive fields (present
 * only for pendant actions).
 */
// guardrails-allow PREVENT-PI-004: opt-in, confirm-gated, npm-delegated install action (subprocess of committed npm tooling; no URL literals)
export async function runInstallNativeOrt(
  stateDir: string,
): Promise<SetupCortexActionResultWithNativeOrt> {
  const ts = Date.now();
  const logName = `install-native-ort-${ts}.log`;
  const logPath = join(ensureLogDir(stateDir), logName);

  const root = nativeOrtDir();
  const platform = hostPlatform();
  if (platform === null) {
    writeLog(logPath, "install-native-ort: host platform has no native binding\n");
    return {
      action: "install-native-ort",
      ok: false,
      exitCode: null,
      logPath,
      logName,
      spawned: false,
    };
  }

  // Step 1: derive the tarball URL + fetch the tarball via the operator's npm.
  // (The tarball never lands in the final prefix until the pinned sha matches.)
  mkdirSync(root, { recursive: true });
  const packedName = `${NATIVE_ORT_PACKAGE}-${NATIVE_ORT_VERSION}.tgz`;
  const packedPath = join(root, packedName);
  let out = "";
  const run = (argv: readonly string[]): { code: number; stdio: string } => {
    const res = spawnSync("npm", argv, { encoding: "utf8", timeout: 60_000 });
    out += [res.stdout, res.stderr].filter(Boolean).join("\n") + "\n";
    return { code: res.status ?? 1, stdio: out };
  };

  // npm pack <pkg>@<ver> --pack-destination <root>
  // guardrails-allow PREVENT-PI-004: npm-delegated tarball fetch (opt-in
  // confirm-gated install action; package@version come from the committed
  // artifacts module, never a literal URL).
  const pack = run([
    "pack",
    `${NATIVE_ORT_PACKAGE}@${NATIVE_ORT_VERSION}`,
    "--pack-destination",
    root,
  ]);
  if (pack.code !== 0 || !existsSync(packedPath)) {
    writeLog(logPath, `${out}npm pack failed — could not download tarball\n`);
    const retest: NativeOrtRetestResult | null = await runNativeRetest(stateDir);
    return {
      action: "install-native-ort",
      ok: false,
      exitCode: pack.code,
      logPath,
      logName,
      spawned: true,
      nativeOrtRetestResult: retest,
      nativeOrtBackendEffective:
        retest !== null && retest.verdict === "qualified" ? "native" : "wasm",
    };
  }

  // Step 2: verify sha256 BEFORE install.
  const actual = sha256File(packedPath);
  if (actual !== NATIVE_ORT_TARBALL_SHA256) {
    writeLog(
      logPath,
      `${out}sha256 mismatch — expected ${NATIVE_ORT_TARBALL_SHA256}, got ${actual}\n`,
    );
    // guardrails-allow PREVENT-PI-004: removing a tarball we just wrote (local FS)
    rmSync(packedPath, { force: true });
    const retest: NativeOrtRetestResult | null = await runNativeRetest(stateDir);
    return {
      action: "install-native-ort",
      ok: false,
      exitCode: 1,
      logPath,
      logName,
      spawned: true,
      nativeOrtRetestResult: retest,
      nativeOrtBackendEffective:
        retest !== null && retest.verdict === "qualified" ? "native" : "wasm",
    };
  }

  // Step 3: install from the VERIFIED local tarball (npm install --prefix).
  // guardrails-allow PREVENT-PI-004: npm-delegated install from a local tarball
  // (opt-in confirm-gated install action).
  const install = run(["install", "--prefix", root, packedPath]);
  // guardrails-allow PREVENT-PI-004: removing the local tarball after install
  rmSync(packedPath, { force: true });

  const installedPkg = join(root, "node_modules", NATIVE_ORT_PACKAGE, "package.json");
  if (install.code !== 0 || !existsSync(installedPkg)) {
    writeLog(logPath, `${out}npm install from verified tarball failed\n`);
    const retest: NativeOrtRetestResult | null = await runNativeRetest(stateDir);
    return {
      action: "install-native-ort",
      ok: false,
      exitCode: install.code,
      logPath,
      logName,
      spawned: true,
      nativeOrtRetestResult: retest,
      nativeOrtBackendEffective:
        retest !== null && retest.verdict === "qualified" ? "native" : "wasm",
    };
  }

  // Step 4: success — write the marker, log, then retest.
  writeMarker(root, platform);
  writeLog(
    logPath,
    `${out}installed ${NATIVE_ORT_PACKAGE}@${NATIVE_ORT_VERSION} (${platform}); sha256 verified + marker written.\n`,
  );
  const retest: NativeOrtRetestResult | null = await runNativeRetest(stateDir);

  return {
    action: "install-native-ort",
    ok: true,
    exitCode: install.code,
    logPath,
    logName,
    spawned: true,
    nativeOrtRetestResult: retest,
    nativeOrtBackendEffective:
      retest !== null && retest.verdict === "qualified" ? "native" : "wasm",
  };
}
