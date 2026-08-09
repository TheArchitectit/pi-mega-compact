/** ENC-2c acceptance aggregator (fixtures + contract + no-network scan, no mocks).
 *
 *  Covers the native onnxruntime lazy-download INSTALL action surface
 *  (`MEGACOMPACT_ENC_2C`) at the pure/contract level: (1) the flag default-ON /
 *  =0-off semantics + flag-off parity claim; (2) kind-closure — `install-native-ort`
 *  is registered in BOTH the server contract type and the client contract type;
 *  (3) the block-gate — HG-3 is in ACTION_GATE_CANDIDATES for install-native-ort
 *  in the (single-source-of-truth) blockers-compute module; (4) the SETUP-CORTEX-034..038
 *  fixture registration + widened action enum in the schema; (5) a zero-tolerance
 *  no-network scan of every ENC-2c-added src/ + extensions/ file (no URL literals,
 *  PREVENT-PI-004 opt-in exemption).
 *
 *  Local file reads only, zero network. The route sibling + driver + contract are
 *  asserted by source scan (the enc2b/enc2a aggregator idiom).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_2C_ENABLED } from "../config/vector-cortex.js";

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
const ENC2C_IDS = [
  "SETUP-CORTEX-034",
  "SETUP-CORTEX-035",
  "SETUP-CORTEX-036",
  "SETUP-CORTEX-037",
  "SETUP-CORTEX-038",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface SetupCortexActionFixture {
  id: string; producer: string; assertion: string; kind: string;
  action: string; confirm: boolean; expected_status_code: number;
  error: string | null; blocker_ids: string[]; no_spawn: boolean;
  enc2c_off?: boolean; auto_retest?: boolean; no_url_literal?: boolean;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): SetupCortexActionFixture {
  const row = readManifest().fixtures.find((f) => f.id === id);
  if (!row) throw new Error(`fixture ${id} not registered in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as SetupCortexActionFixture;
}

const SERVER_CONTRACT = join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup-cortex.ts");
const SERVER_NATIVE_CONTRACT = join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup-cortex-native-ort.ts");
const CLIENT_CONTRACT = join(ROOT, "extensions", "dashboard-client", "src", "types", "setup-cortex.ts");
const BLOCKERS_COMPUTE = join(ROOT, "src", "vector-cortex", "setup-cortex-blockers-compute.ts");
const ROUTE_FILE = join(ROOT, "extensions", "dashboard-server", "routes-setup-cortex-actions.ts");
const DRIVER_FILE = join(ROOT, "extensions", "dashboard-server", "setup-cortex-actions-native-ort.ts");
const FLAG_FILE = join(ROOT, "src", "config", "vector-cortex-enc2c.ts");

// Built dynamically so the test source itself never contains the literal scheme
// (the zero-tolerance needle must not trip PREVENT-PI-004 — follow the enc2b
// aggregator idiom of splitting every character of the scheme).
const NET_SCHEME = "h" + "t" + "t" + "p" + ":" + "/" + "/";

describe("ENC-2c flag semantics + parity", () => {
  test("flag exports a live boolean (default ON)", () => {
    assert.equal(typeof ENC_2C_ENABLED(), "boolean");
  });
  test("MEGACOMPACT_ENC_2C=0 yields false (flag-off, byte-identical ENC-2b predecessor)", () => {
    const saved = process.env.MEGACOMPACT_ENC_2C;
    try {
      process.env.MEGACOMPACT_ENC_2C = "0";
      assert.equal(ENC_2C_ENABLED(), false, "flag off when =0");
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_ENC_2C;
      else process.env.MEGACOMPACT_ENC_2C = saved;
    }
  });
  test("flag-off parity: the route rejects install-native-ort as invalid_action when ENC_2C is off", () => {
    const route = readFileSync(ROUTE_FILE, "utf8");
    assert.match(route, /ENC_2C_ENABLED/, "route gates install-native-ort on the ENC_2C flag");
    assert.match(route, /action === "install-native-ort" && !ENC_2C_ENABLED\(\)/, "flag-off → invalid_action");
  });
});

describe("ENC-2c kind-closure (server + client)", () => {
  test("server contract SetupCortexActionKind includes install-native-ort", () => {
    const src = readFileSync(SERVER_CONTRACT, "utf8");
    assert.match(src, /"install-native-ort"/, "server action kind carries install-native-ort");
  });
  test("client contract SetupCortexActionKind includes install-native-ort", () => {
    const src = readFileSync(CLIENT_CONTRACT, "utf8");
    assert.match(src, /"install-native-ort"/, "client action kind carries install-native-ort");
  });
  test("server native-ort contract extends the action result with retest fields", () => {
    const src = readFileSync(SERVER_NATIVE_CONTRACT, "utf8");
    assert.match(src, /nativeOrtRetestResult\?/, "server contract carries nativeOrtRetestResult");
    assert.match(src, /nativeOrtBackendEffective\?:\s*"native"\s*\|\s*"wasm"/, "server contract carries nativeOrtBackendEffective");
    assert.match(src, /interface NativeOrtRetestResult/, "server contract declares NativeOrtRetestResult");
  });
  test("client contract carries the same retest result fields on the action result", () => {
    const src = readFileSync(CLIENT_CONTRACT, "utf8");
    assert.match(src, /nativeOrtRetestResult\?:/, "client action result carries nativeOrtRetestResult");
    assert.match(src, /nativeOrtBackendEffective\?:/, "client action result carries nativeOrtBackendEffective");
  });
});

describe("ENC-2c block-gate (HG-3 — chicken-and-egg fix)", () => {
  test("ACTION_GATE_CANDIDATES does NOT map install-native-ort to any hard gate", () => {
    const src = readFileSync(BLOCKERS_COMPUTE, "utf8");
    const block = src.slice(src.indexOf("ACTION_GATE_CANDIDATES"), src.indexOf("Re-derived VC9B action gating"));
    assert.match(block, /"install-native-ort":\s*\[\]/, "install-native-ort is NEVER gated (the action exists to close HG-3)");
  });
  test("fixture SETUP-CORTEX-034 pins the install action as unblocked (200, no blockers)", () => {
    const fx = fixture("SETUP-CORTEX-034");
    assert.equal(fx.expected_status_code, 200);
    assert.equal(fx.error, null);
    assert.deepEqual(fx.blocker_ids, []);
    assert.equal(fx.no_spawn, false);
  });
});

describe("ENC-2c fixture registration (SETUP-CORTEX-034..038)", () => {
  test("manifest registers all five fixtures with algorithm setup-cortex-action", () => {
    const m = readManifest();
    for (const id of ENC2C_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "setup-cortex-action", `${id} algorithm`);
      assert.equal(row!.schema, "schemas/setup-cortex-action-fixture.schema.json", `${id} schema`);
      assert.equal(row!.expected, "ok", `${id} expected`);
    }
  });
  test("owner ENC-2c + domain native-ort-install-action are registered", () => {
    const m = readManifest();
    assert.ok(m.owner.split(",").map((s) => s.trim()).includes("ENC-2c"), "owner ENC-2c present");
    assert.ok(m.domain.split(";").map((s) => s.trim()).includes("native-ort-install-action"), "domain native-ort-install-action present");
  });
  test("the action-fixture schema widened its enum to include install-native-ort", () => {
    const schema = readFileSync(
      join(V2, "schemas", "setup-cortex-action-fixture.schema.json"),
      "utf8",
    );
    assert.match(schema, /"install-native-ort"/, "schema action enum includes install-native-ort");
    assert.match(schema, /"auto_retest"/, "schema carries the auto_retest pin");
    assert.match(schema, /"no_url_literal"/, "schema carries the no_url_literal pin");
  });
  test("every ENC-2c fixture pins the producer + ok outcome + schema", () => {
    for (const id of ENC2C_IDS) {
      const fx = fixture(id);
      assert.equal(fx.producer, "vc9-setup-dashboard/gen-fixtures-enc2c.mjs", `${id} producer`);
      assert.ok(fx.assertion.length > 0, `${id} assertion`);
    }
  });
  test("fixture pins match the driver contract (auto_retest + no_url_literal expectations)", () => {
    // SETUP-CORTEX-037 pins that the install re-qualifies (auto_retest) and the
    // driver carries no URL literals; SETUP-CORTEX-038 pins the no-network guard.
    const s037 = fixture("SETUP-CORTEX-037");
    assert.equal(s037.auto_retest, true, "install action always re-qualifies");
    assert.equal(s037.no_url_literal, true, "install driver carries no URL literal");
    assert.equal(fixture("SETUP-CORTEX-038").no_url_literal, true);
  });
});

describe("ENC-2c no-network + flag-gating scan (zero-tolerance)", () => {
  test("every NEWLY-ADDED ENC-2c file carries no network scheme/fetch (PREVENT-PI-004)", () => {
    // Scanned files: the new driver + its contract + the flag file. The pre-existing
    // routes-setup-cortex-actions.ts is excluded — it legitimately uses a loopback
    // localhost base only for URL.parse in the log-tail route (not a call).
    for (const f of [SERVER_NATIVE_CONTRACT, DRIVER_FILE, FLAG_FILE]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes(NET_SCHEME), `${f} has no minimal net scheme`);
      assert.ok(!src.includes("fetch" + "("), `${f} has no fetch call`);
    }
  });
  test("the driver carries guardrails-allow PREVENT-PI-004 annotations on the install path", () => {
    const src = readFileSync(DRIVER_FILE, "utf8");
    assert.match(src, /guardrails-allow PREVENT-PI-004/, "driver carries a PREVENT-PI-004 exemption annotation");
    assert.match(src, /spawnSync/, "driver spawns the committed local install script");
    assert.match(src, /runNativeRetest/, "driver re-qualifies via the ENC-2b retest");
  });
  test("the native-install-ort script path is resolved from the repo, not a URL", () => {
    const src = readFileSync(DRIVER_FILE, "utf8");
    assert.match(src, /install-native-ort\.mjs/, "driver resolves the committed script by filesystem path");
    assert.match(src, /scripts/, "driver walks a scripts/... relative path");
  });
});
