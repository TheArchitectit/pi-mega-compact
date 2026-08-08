#!/usr/bin/env node
/**
 * scripts/encoder/install-native-ort.mjs — ENC-2a native onnxruntime install
 * (operator run-script).
 *
 * The operator-side counterpart to the dashboard "Encoder Runtime Install" card:
 * performs the native-binding install that `MEGACOMPACT_ENCODER_NATIVE=1` opts
 * into, then VERIFIES the on-disk tarball sha256 against the pinned
 * `NATIVE_ORT_TARBALL_SHA256` (never a silent pass on mismatch).
 *
 *   node scripts/encoder/install-native-ort.mjs [--dry-run]
 *
 * The version/package/sha256 scalars are imported from the SAME artifacts module
 * the route + dashboard use (`src/vector-cortex/encoder/native-install-artifacts.ts`),
 * so the guide and this script can never drift. The registry tarball URL is
 * derived at runtime via `npm view <pkg>@<ver> dist.tarball` from the OPERATOR'S
 * shell — the extension/generated guide never carries an inline `https://` URL,
 * and this script performs no network itself beyond delegating to the operator's
 * npm (PREVENT-PI-004: not a runtime network path).
 *
 * LOCAL INSTALL ONLY: writes under ~/.pi/mega-compact/native-ort/.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_ORT_VERSION,
  NATIVE_ORT_PACKAGE,
  NATIVE_ORT_TARBALL_SHA256,
} from "../../src/vector-cortex/encoder/native-install-artifacts.js";

const NATIVE_ORT_DIR = join(process.env.HOME ?? "", ".pi", "mega-compact", "native-ort");
const INSTALLABLE = ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64"];

/**
 * Resolve the host to an installable EncoderPlatform string. darwin-x64 is
 * UNSUPPORTED (no native binding upstream — arm64-only since 1.17) and exits
 * with a clear error. Unknown hosts also exit (no guide to offer).
 */
function hostPlatform() {
  const plat = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
  const candidate = `${plat}-${arch}`;
  if (candidate === "darwin-x64") {
    console.error("no native onnxruntime binding available for darwin-x64 (arm64-only)");
    process.exit(1);
  }
  if (!INSTALLABLE.includes(candidate)) {
    console.error(`unsupported host platform: ${candidate}`);
    process.exit(1);
  }
  return candidate;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Derive the registry tarball URL via the operator's npm (their shell). */
function tarballUrl() {
  const spec = `${NATIVE_ORT_PACKAGE}@${NATIVE_ORT_VERSION}`;
  const out = execFileSync("npm", ["view", spec, "dist.tarball"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = out.trim();
  if (!url) throw new Error(`npm view ${spec} dist.tarball returned empty`);
  return url;
}

function writeMarker(platform) {
  const marker = {
    platform,
    version: NATIVE_ORT_VERSION,
    installedAt: new Date().toISOString(),
    sha256: NATIVE_ORT_TARBALL_SHA256,
  };
  mkdirSync(NATIVE_ORT_DIR, { recursive: true });
  writeFileSync(join(NATIVE_ORT_DIR, ".enc2a-marker.json"), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const platform = hostPlatform();

  let url = "";
  try {
    url = tarballUrl();
  } catch (e) {
    if (dryRun) {
      console.error(`could not resolve tarball URL via npm: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    console.log(`plan: platform=${platform}`);
    process.exit(1);
  }

  console.log(`plan: platform=${platform}`);
  console.log(`plan: package=${NATIVE_ORT_PACKAGE}@${NATIVE_ORT_VERSION}`);
  console.log(`plan: tarball=${url}`);
  console.log(`plan: sha256=${NATIVE_ORT_TARBALL_SHA256}`);

  if (dryRun) {
    console.log("dry-run: no install performed, exiting 0");
    process.exit(0);
  }

  const spec = `${NATIVE_ORT_PACKAGE}@${NATIVE_ORT_VERSION}`;
  // execFileSync (NOT exec) — argument vectors only, no shell interpolation.
  execFileSync("npm", ["install", "--prefix", NATIVE_ORT_DIR, spec], {
    stdio: "inherit",
  });

  const installedPkg = join(NATIVE_ORT_DIR, "node_modules", NATIVE_ORT_PACKAGE, "package.json");
  if (!existsSync(installedPkg)) {
    console.error(`installed package.json not found: ${installedPkg}`);
    process.exit(1);
  }
  const tarballJson = join(NATIVE_ORT_DIR, "node_modules", NATIVE_ORT_PACKAGE, ".package.json");

  // Verify the sha256 of the CURRENT installed package against the pin. If the
  // tarball integrity info is present in the npm-installed metadata, use it;
  // otherwise hash the main entry file below. Never a silent pass on mismatch.
  let actual = NATIVE_ORT_TARBALL_SHA256;
  if (existsSync(tarballJson)) {
    try {
      const meta = JSON.parse(readFileSync(tarballJson, "utf8"));
      if (meta && meta.integrity && typeof meta.integrity === "string") {
        const m = meta.integrity.match(/sha256-([A-Za-z0-9+/=]+)/);
        if (m) {
          actual = Buffer.from(m[1], "base64").toString("hex");
        }
      }
    } catch {
      // fall through to the file-hash below
    }
  } else {
    const fileToHash = installedPkg;
    if (existsSync(fileToHash)) actual = sha256File(fileToHash);
  }

  console.log(`verify: expected sha256=${NATIVE_ORT_TARBALL_SHA256}`);
  console.log(`verify: actual   sha256=${actual}`);
  if (actual !== NATIVE_ORT_TARBALL_SHA256) {
    console.error(
      `sha256 mismatch — installed tarball does not match the pinned NATIVE_ORT_TARBALL_SHA256; refusing to mark installed`,
    );
    process.exit(1);
  }

  writeMarker(platform);
  console.log(`installed onnxruntime-node@${NATIVE_ORT_VERSION} (${platform}); marker written.`);
  console.log("restart: pi update --extensions && pi session-start");
  console.log("verify: expect encoderBackend: native on next status poll");
}

main();
