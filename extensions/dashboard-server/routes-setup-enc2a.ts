/**
 * dashboard-server/routes-setup-enc2a.ts — ENC-2a native onnxruntime install
 * GUIDE (reader-only) + installed-version probe.
 *
 * Extracted out of routes-setup.ts (which hovers at the 300-line source soft
 * cap, mirroring the ENC-1a/ENC-1b/ENC-2budget sibling extracts) so the
 * ENC-2a additive GET fields — the platform-matched native install guide and
 * the installed-version probe — live in a sibling impl file and routes-setup.ts
 * stays a thin host.
 *
 * The guide's job is OPERATOR run-script assist: when the operator opted into
 * the native backend (`MEGACOMPACT_ENCODER_NATIVE=1`) but the effective runtime
 * is still `"wasm"` (onnxruntime-node not yet installed) AND the host platform
 * is installable, the GET status response carries a `nativeOrtInstallGuide`
 * object with the [install, restart, verify] copy-paste commands + the committed
 * operator script path. The commands/URL/hash are built ONLY from the artifacts
 * module constants (`src/vector-cortex/encoder/native-install-artifacts.ts`) —
 * never an inline registry URL or literal hash (PREVENT-PI-004). The installed-
 * version probe reads the local `~/.pi/mega-compact/native-ort/` package.json
 * when present (reader-only filesystem read, zero network).
 *
 * The flag is off (or opt-in off / unsupported platform / non-wasm backend) ->
 * guide `null` and installedVersion `null` -> the host omits both fields,
 * byte-identical to the ENC-1b-era shape.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem reads + in-memory backend
 * selection only, zero network), PREVENT-001 (null-safe JSON), PREVENT-011
 * (no `any`).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ENC_2A_ENABLED } from "../../src/config/vector-cortex.js";
import { readEnc1bEnv } from "./routes-setup-enc1b.js";
import { selectRuntimeBackend } from "../../src/vector-cortex/encoder/runtime-select.js";
import { detectPlatform } from "../../src/vector-cortex/encoder/asset.js";
import {
  NATIVE_ORT_VERSION,
  NATIVE_ORT_PACKAGE,
  NATIVE_ORT_INSTALLABLE_PLATFORMS,
} from "../../src/vector-cortex/encoder/native-install-artifacts.js";
import type { SetupConfigureRequest } from "./api-contracts/setup.js";

/** The committed operator script that performs the install (repo-relative). */
const ENC_2A_SCRIPT_PATH = "scripts/encoder/install-native-ort.mjs";

/** Where the operator script installs the native binding (absolute install
 *  prefix used verbatim in the guide commands + the version probe). The
 *  MEGACOMPACT_NATIVE_ORT_ROOT override exists so tests can point at an empty
 *  dir (isolation from a globally-installed binding). */
function nativeOrtDir(): string {
  const override = process.env.MEGACOMPACT_NATIVE_ORT_ROOT;
  if (override !== undefined && override.length > 0) return override;
  return join(process.env.HOME ?? "", ".pi", "mega-compact", "native-ort");
}

/**
 * True when the payload carries the ENC-2a guide-request key `false`/`true`
 * (flag-gated, additive). `false` -> 400 (operator-driven no-op); `true` -> 200
 * + the guide echoed (still no server execution — the execute path is ENC-2c).
 * Flag-off -> null so the key falls through unrecognized (byte-identical
 * ENC-1b-era predecessor).
 */
export function enc2aGuideRequest(
  body: SetupConfigureRequest,
): { status: 400 } | { status: 200 } | null {
  if (!ENC_2A_ENABLED()) return null;
  if (body.nativeOrtInstallGuide === true) return { status: 200 };
  if (body.nativeOrtInstallGuide === false) return { status: 400 };
  return null;
}

/**
 * Read the ENC-2a native install GUIDE + installed-version, additive GET fields.
 *
 * The guide renders only when EVERY gate passes: flag on, operator opted into
 * native, effective backend is still `"wasm"` (onnxruntime-node absent), and the
 * host platform is installable (darwin-x64 is excluded — no native binding
 * upstream, the ENC-0e demotion sentinel). The effective backend + demotion
 * reason go through the EXISTING `selectRuntimeBackend` (reader-only — never a
 * reimplemented literal). `installedVersion` probes
 * `~/.pi/mega-compact/native-ort/node_modules/onnxruntime-node/package.json`
 * when present; null otherwise. Returns `{ guide: null, installedVersion: null }`
 * when the flag is off (byte-identical predecessor).
 */
export function readEnc2aGuide(stateDir: string): {
  guide: { platform: string; commands: readonly string[]; scriptPath: string } | null;
  installedVersion: string | null;
} {
  if (!ENC_2A_ENABLED()) return { guide: null, installedVersion: null };
  const env = readEnc1bEnv(stateDir);
  const platform = detectPlatform();
  const chosen = selectRuntimeBackend({
    platform: platform ?? "unsupported",
    benchRecord: null,
    nativeOptIn: env.nativeOptIn,
  });
  const backend = chosen.backend === "native" ? "native" : "wasm";

  let guide: { platform: string; commands: readonly string[]; scriptPath: string } | null = null;
  if (
    env.nativeOptIn &&
    backend === "wasm" &&
    platform !== null &&
    (NATIVE_ORT_INSTALLABLE_PLATFORMS as readonly string[]).includes(platform)
  ) {
    guide = {
      platform,
      commands: [
        `npm install --prefix ${nativeOrtDir()} ${NATIVE_ORT_PACKAGE}@${NATIVE_ORT_VERSION}`,
        "pi update --extensions && pi session-start",
        "expect encoderBackend: native on next status poll",
      ],
      scriptPath: ENC_2A_SCRIPT_PATH,
    };
  }

  return { guide, installedVersion: probeInstalledVersion(stateDir) };
}

/** Probe the local native-ort package.json for the installed onnxruntime-node
 *  version. Probes `<stateDir>/native-ort/` first (test isolation), then the
 *  global `~/.pi/mega-compact/native-ort/`. Null when the package is
 *  absent/unreadable in both roots (reader-only, local). */
function probeInstalledVersion(stateDir: string): string | null {
  for (const root of [join(stateDir, "native-ort"), nativeOrtDir()]) {
    const v = probeVersionAt(root);
    if (v !== null) return v;
  }
  return null;
}

/** Version probe for one candidate root. */
function probeVersionAt(root: string): string | null {
  try {
    const pkgPath = join(root, "node_modules", NATIVE_ORT_PACKAGE, "package.json");
    if (!existsSync(pkgPath)) return null;
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown;
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { version?: unknown }).version === "string"
    ) {
      return (raw as { version: string }).version;
    }
    return null;
  } catch {
    return null;
  }
}
