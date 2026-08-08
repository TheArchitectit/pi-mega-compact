/** ENC-2a acceptance aggregator (fixtures + contract + artifacts scan, no mocks).
 *
 *  Covers the native onnxruntime install-guide surface
 *  (`MEGACOMPACT_ENC_2A`) at the pure/contract level: (1) the ENC-INSTALL-001..006
 *  fixture registration + kind-closure against the encoder-install-guide seam;
 *  (2) the artifacts module's pinned scalars satisfy every fixture — the single
 *  monolithic tarball sha256 is lowercase hex length 64, the version is a
 *  major.minor.patch semver, the installable-platform matrix excludes darwin-x64
 *  (the ENC-0e demotion sentinel keeps the guide absent on an Intel Mac); (3)
 *  the additive contract fields surface only when the flag is on and the route
 *  host builds the guide purely from the artifacts constants (no inline registry
 *  URL/hash — PREVENT-PI-004); (4) the flag-agnostic export (passes with
 *  ENC_2A ON or OFF).
 *
 *  Local file reads only, zero network. All JS imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson); the route host + contract
 *  are asserted by source scan (the enc1b/enc2budget aggregator idiom).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_ORT_VERSION,
  NATIVE_ORT_PACKAGE,
  NATIVE_ORT_TARBALL_SHA256,
  NATIVE_ORT_INSTALLABLE_PLATFORMS,
} from "./encoder/native-install-artifacts.js";
import { ENC_2A_ENABLED } from "../config/vector-cortex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const ROOT = repoRoot(HERE);
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const ENC_INSTALL_IDS = [
  "ENC-INSTALL-001",
  "ENC-INSTALL-002",
  "ENC-INSTALL-003",
  "ENC-INSTALL-004",
  "ENC-INSTALL-005",
  "ENC-INSTALL-006",
] as const;
const GUIDE_KINDS = [
  "guide-round-trip",
  "constants-present",
  "sha256-format",
  "darwin-guide-absent",
  "flag-off",
  "contract-additive",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface InstallFixture {
  id: string; producer: string; assertion: string; kind: string;
  schema: string;
  setup: { platform: string; native_opt_in?: boolean; effective_backend?: string; flag_off?: boolean };
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): InstallFixture {
  const row = readManifest().fixtures.find((f) => f.id === id);
  if (!row) throw new Error(`fixture ${id} not registered in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as InstallFixture;
}

describe("ENC-2a fixture registration + kind-closure", () => {
  test("manifest registers ENC-INSTALL-001..006 with algorithm encoder-install-guide", () => {
    const m = readManifest();
    for (const id of ENC_INSTALL_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "encoder-install-guide", `${id} algorithm`);
      assert.equal(row!.schema, "schemas/encoder-install-guide-fixture.schema.json", `${id} schema`);
      assert.equal(row!.expected, "ok", `${id} expected`);
    }
  });
  test("the fixture schema is registered", () => {
    const m = readManifest();
    const row = m.fixtures.find((f) => f.id === "encoder-install-guide-fixture");
    assert.ok(row, "encoder-install-guide-fixture schema row registered");
    assert.equal(row!.path, "schemas/encoder-install-guide-fixture.schema.json");
    assert.equal(row!.algorithm, "json-schema", "schema row algorithm");
  });
  test("owner ENC-2a + domain encoder-install-guide are registered", () => {
    const m = readManifest();
    assert.ok(m.owner.split(",").map((s) => s.trim()).includes("ENC-2a"), "owner ENC-2a present");
    assert.ok(m.domain.split(";").map((s) => s.trim()).includes("encoder-install-guide"), "domain encoder-install-guide present");
  });
  test("the six ENC-INSTALL kinds are closed to the spec branch set", () => {
    const kinds = new Set(fixture("ENC-INSTALL-001") && ENC_INSTALL_IDS.map((id) => fixture(id).kind));
    for (const k of GUIDE_KINDS) assert.ok(kinds.has(k), `branch kind ${k} present`);
  });
  test("every fixture pins the producer + schema + ok outcome", () => {
    for (const id of ENC_INSTALL_IDS) {
      const fx = fixture(id);
      assert.equal(fx.producer, "ml5-enc/gen-fixtures.mjs", `${id} producer`);
      assert.equal(fx.schema, "schemas/encoder-install-guide-fixture.schema.json", `${id} schema`);
      assert.ok(fx.assertion.length > 0, `${id} assertion`);
    }
  });
});

describe("ENC-2a artifacts module satisfies the fixture pins", () => {
  test("single monolithic tarball sha256 is lowercase hex length 64 (ENC-INSTALL-002/003)", () => {
    assert.equal(typeof NATIVE_ORT_TARBALL_SHA256, "string");
    assert.match(NATIVE_ORT_TARBALL_SHA256, /^[0-9a-f]{64}$/, "sha256 lowercase hex length 64");
    const fx = fixture("ENC-INSTALL-002");
    assert.equal(NATIVE_ORT_TARBALL_SHA256, fx.expected_result.sha256, "artifact sha256 matches fixture pin");
    const f3 = fixture("ENC-INSTALL-003");
    assert.equal(f3.expected_result.sha256_lowercase_hex64, true, "fixture flags sha256 format");
  });
  test("version is a major.minor.patch semver (ENC-INSTALL-003)", () => {
    assert.match(NATIVE_ORT_VERSION, /^\d+\.\d+\.\d+$/, "version semver major.minor.patch");
    assert.equal(NATIVE_ORT_VERSION, fixture("ENC-INSTALL-002").expected_result.version, "artifact version matches fixture pin");
  });
  test("package name is onnxruntime-node (ENC-INSTALL-002)", () => {
    assert.equal(NATIVE_ORT_PACKAGE, "onnxruntime-node");
    assert.equal(NATIVE_ORT_PACKAGE, fixture("ENC-INSTALL-002").expected_result.package);
  });
  test("installable-platform matrix excludes darwin-x64 (no native binding — ENC-INSTALL-004)", () => {
    assert.ok(!(NATIVE_ORT_INSTALLABLE_PLATFORMS as readonly string[]).includes("darwin-x64"), "darwin-x64 NOT installable");
    assert.ok((NATIVE_ORT_INSTALLABLE_PLATFORMS as readonly string[]).includes("linux-x64"), "linux-x64 installable");
    const fx = fixture("ENC-INSTALL-004");
    assert.equal(fx.expected_result.guide_absent, true, "darwin-x64 fixture expects guide absent");
    assert.equal(fx.expected_result.demotion_sentinel, true, "darwin-x64 demotion sentinel");
  });
  test("route guide build gate: guide round-trip command matches the fixture (ENC-INSTALL-001)", () => {
    const fx = fixture("ENC-INSTALL-001");
    assert.equal(fx.setup.platform, "linux-x64");
    assert.equal(fx.setup.native_opt_in, true);
    assert.equal(fx.setup.effective_backend, "wasm");
    assert.equal(fx.expected_result.guide_commands_length, 3, "install/restart/verify");
    assert.match(fx.expected_result.step1_install as string, /npm install --prefix ~\/\.pi\/mega-compact\/native-ort onnxruntime-node@\d+\.\d+\.\d+/, "install command shape");
    assert.equal(fx.expected_result.script_path, "scripts/encoder/install-native-ort.mjs");
  });
});

describe("ENC-2a flag + contract additivity", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_2A_ENABLED(), "boolean");
  });
  test("flag-off: MEGACOMPACT_ENC_2A=0 yields false (ENC-INSTALL-005 byte-identical)", () => {
    const saved = process.env.MEGACOMPACT_ENC_2A;
    try {
      process.env.MEGACOMPACT_ENC_2A = "0";
      assert.equal(ENC_2A_ENABLED(), false, "flag off when =0");
      const fx = fixture("ENC-INSTALL-005");
      assert.equal(fx.setup.flag_off, true, "flag-off fixture setup");
      assert.equal(fx.expected_result.guide_absent, true, "flag-off omits guide");
      assert.equal(fx.expected_result.installed_absent, true, "flag-off omits installed version");
      assert.equal(fx.expected_result.byte_identical, true, "flag-off byte-identical to ENC-1b era");
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_ENC_2A;
      else process.env.MEGACOMPACT_ENC_2A = saved;
    }
  });
  test("status contract carries the additive nativeOrtInstallGuide + nativeOrtInstalledVersion fields", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const getBlock = contracts.slice(
      contracts.indexOf("interface SetupStatusResponse"),
      contracts.indexOf("interface DetectResult"),
    );
    assert.match(getBlock, /nativeOrtInstallGuide\?:/, "status carries optional nativeOrtInstallGuide");
    assert.match(getBlock, /nativeOrtInstalledVersion\?:\s*string\s*\|\s*null/, "status carries nativeOrtInstalledVersion string|null");
  });
  test("configure request carries the additive nativeOrtInstallGuide boolean guide-request key", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const postBlock = contracts.slice(
      contracts.indexOf("interface SetupConfigureRequest"),
      contracts.indexOf("interface SetupConfigureResponse"),
    );
    assert.match(postBlock, /nativeOrtInstallGuide\?:\s*boolean/, "configure request carries guide-request boolean");
  });
});

describe("ENC-2a no-inline-URL + flag-gating scan (zero-tolerance)", () => {
  const routeFile = join(ROOT, "extensions", "dashboard-server", "routes-setup-enc2a.ts");
  // Built dynamically so the test source itself never contains the literal
  // registry scheme (the zero-tolerance needle must not trip PREVENT-PI-004).
  const REG_SCHEME = "http" + "s" + ":" + "/" + "/";

  test("the artifacts module and route host carry no inline registry URL", () => {
    const artifacts = readFileSync(
      join(ROOT, "src", "vector-cortex", "encoder", "native-install-artifacts.ts"),
      "utf8",
    );
    assert.ok(!artifacts.includes(REG_SCHEME), "artifacts module has no inline registry scheme");
    assert.ok(!artifacts.includes("registry.npmjs.org"), "artifacts module has no registry host literal");
    const route = readFileSync(routeFile, "utf8");
    assert.ok(!route.includes(REG_SCHEME), "route host has no inline registry scheme (PREVENT-PI-004)");
  });
  test("the route builds the guide from the artifacts constants (no inline hash)", () => {
    const route = readFileSync(routeFile, "utf8");
    assert.match(route, /NATIVE_ORT_PACKAGE/, "route derives install command from NATIVE_ORT_PACKAGE");
    assert.match(route, /NATIVE_ORT_VERSION/, "route pins NATIVE_ORT_VERSION");
    assert.match(route, /NATIVE_ORT_INSTALLABLE_PLATFORMS/, "route gates on the installable-platform matrix");
    assert.ok(!route.includes("c3779c01c59832f8c03e2c392ac3af10bf08579f1822e8b1c63cc451edb302a2"), "route has no inline sha256 literal");
  });
  test("the route reader is gated on ENC_2A_ENABLED (flag-off -> guide null)", () => {
    const route = readFileSync(routeFile, "utf8");
    assert.match(route, /ENC_2A_ENABLED\(\)/, "readEnc2aGuide gates on the flag");
    assert.match(route, /nativeOptIn/, "guide requires native opt-in");
    assert.match(route, /"wasm"/, "guide requires wasm effective backend");
  });
  test("the route host contains no console.log", () => {
    const routesHost = join(ROOT, "extensions", "dashboard-server", "routes-setup.ts");
    for (const f of [routeFile, routesHost]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes("console.log"), `${f} must not call console.log`);
    }
  });
});
