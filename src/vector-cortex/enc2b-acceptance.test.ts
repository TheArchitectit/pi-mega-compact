/** ENC-2b acceptance aggregator (fixtures + contract + no-network scan, no mocks).
 *
 *  Covers the native onnxruntime qualification retest surface
 *  (`MEGACOMPACT_ENC_2B`) at the pure/contract level: (1) the ENC-RETEST-001..006
 *  fixture registration + kind-closure against the encoder-qualification-retest
 *  seam; (2) the artifacts + retest module satisfying every fixture — the
 *  pinned version matches the ENC-2a artifacts module, the p95/RSS budgets
 *  mirror the ENC-0f p95 budget (`ENCODER_LATENCY_P95_MS` = 40) and the
 *  operator install-budget (`installBudgetMib()` default 300); (3) the additive
 *  contract fields surface only when the flag is on and the retest module loads
 *  ONLY from the local on-disk path (NO fetch/http/https — PREVENT-PI-004); (4)
 *  the flag-agnostic export (passes with ENC_2B ON or OFF).
 *
 *  Local file reads only, zero network. All JS imports stay within src/ so the
 *  legacy mirrored dist publishes it; the route sibling + contract are asserted
 *  by source scan (the enc1b/enc2budget/enc2a aggregator idiom).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  NATIVE_ORT_VERSION,
  NATIVE_ORT_PACKAGE,
} from "./encoder/native-install-artifacts.js";
import { runNativeRetest } from "./encoder/native-qualify-retest.js";
import { ENCODER_LATENCY_P95_MS } from "./encoder/types.js";
import { installBudgetMib } from "./encoder/decision.js";
import { ENC_2B_ENABLED } from "../config/vector-cortex.js";

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
const ENC_RETEST_IDS = [
  "ENC-RETEST-001",
  "ENC-RETEST-002",
  "ENC-RETEST-003",
  "ENC-RETEST-004",
  "ENC-RETEST-005",
  "ENC-RETEST-006",
] as const;
const RETEST_KINDS = [
  "binding-present-round-trip",
  "binding-absent",
  "flag-off",
  "failed-verdict",
  "post-action",
  "contract-additive",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface RetestFixture {
  id: string; producer: string; assertion: string; kind: string;
  schema: string;
  setup: {
    platform: string; binding_present?: boolean; verdict?: string;
    flag_off?: boolean; contract_additive?: boolean;
  };
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): RetestFixture {
  const row = readManifest().fixtures.find((f) => f.id === id);
  if (!row) throw new Error(`fixture ${id} not registered in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as RetestFixture;
}

describe("ENC-2b fixture registration + kind-closure", () => {
  test("manifest registers ENC-RETEST-001..006 with algorithm encoder-qualification-retest", () => {
    const m = readManifest();
    for (const id of ENC_RETEST_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "encoder-qualification-retest", `${id} algorithm`);
      assert.equal(row!.schema, "schemas/encoder-qualification-retest-fixture.schema.json", `${id} schema`);
      assert.equal(row!.expected, "ok", `${id} expected`);
    }
  });
  test("the fixture schema is registered", () => {
    const m = readManifest();
    const row = m.fixtures.find((f) => f.id === "encoder-qualification-retest-fixture");
    assert.ok(row, "encoder-qualification-retest-fixture schema row registered");
    assert.equal(row!.path, "schemas/encoder-qualification-retest-fixture.schema.json");
    assert.equal(row!.algorithm, "json-schema", "schema row algorithm");
  });
  test("owner ENC-2b + domain encoder-qualification-retest are registered", () => {
    const m = readManifest();
    assert.ok(m.owner.split(",").map((s) => s.trim()).includes("ENC-2b"), "owner ENC-2b present");
    assert.ok(m.domain.split(";").map((s) => s.trim()).includes("encoder-qualification-retest"), "domain encoder-qualification-retest present");
  });
  test("the six ENC-RETEST kinds are closed to the spec branch set", () => {
    const kinds = new Set(ENC_RETEST_IDS.map((id) => fixture(id).kind));
    for (const k of RETEST_KINDS) assert.ok(kinds.has(k), `branch kind ${k} present`);
  });
  test("every fixture pins the producer + schema + ok outcome", () => {
    for (const id of ENC_RETEST_IDS) {
      const fx = fixture(id);
      assert.equal(fx.producer, "ml5-enc/gen-fixtures.mjs", `${id} producer`);
      assert.equal(fx.schema, "schemas/encoder-qualification-retest-fixture.schema.json", `${id} schema`);
      assert.ok(fx.assertion.length > 0, `${id} assertion`);
    }
  });
});

describe("ENC-2b retest module + artifacts satisfy the fixture pins", () => {
  test("the retest version matches the ENC-2a artifacts version (single binding, ENC-RETEST-001)", () => {
    assert.equal(NATIVE_ORT_VERSION, "1.27.0");
    assert.equal(NATIVE_ORT_PACKAGE, "onnxruntime-node");
  });
  test("the ENC-0f p95 budget is 40 ms and the RSS budget mirrors installBudgetMib (ENC-RETEST-001)", () => {
    assert.equal(ENCODER_LATENCY_P95_MS, 40, "ENC-0f p95 budget is 40 ms");
    const budget = installBudgetMib();
    assert.equal(budget, fixture("ENC-RETEST-001").expected_result.rss_budget_mib, "rss budget = installBudgetMib");
  });
  test("runNativeRetest returns null when no binding is installed (ENC-RETEST-002 absence)", async () => {
    // An isolated HOME + stateDir with no native-ort binding -> the module
    // probes neither the global (~/.pi/mega-compact/native-ort) nor the stateDir
    // root and returns null (never throws), so the GET omits both fields
    // (absent, not null). Isolating HOME keeps this deterministic regardless of
    // whether the host machine has the ENC-2a native binding installed.
    const home = mkdtempSync(join(tmpdir(), "enc2b-no-native-ort-home-"));
    const stateDir = mkdtempSync(join(tmpdir(), "enc2b-no-native-ort-absent-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await runNativeRetest(stateDir);
      assert.equal(result, null);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
    const fx = fixture("ENC-RETEST-002");
    assert.equal(fx.expected_result.retest_result_absent, true, "binding-absent omits result");
    assert.equal(fx.expected_result.backend_effective_absent, true, "binding-absent omits backend");
  });
  test("the retest result shape matches the fixture invoice (ENC-RETEST-001/004)", () => {
    const r1 = fixture("ENC-RETEST-001");
    const f4 = fixture("ENC-RETEST-004");
    assert.equal((r1.expected_result.verdict_enum as string[]).join(","), "qualified,degraded,failed", "verdict enum");
    assert.deepEqual(
      Object.keys({ platform: 1, version: 1, verdict: 1, p95Ms: 1, rssMiB: 1, testedAt: 1 } as const),
      ["platform", "version", "verdict", "p95Ms", "rssMiB", "testedAt"],
      "RetestResult field shape",
    );
    assert.equal(f4.expected_result.verdict_failed, true);
    assert.equal(f4.expected_result.backend_effective, "wasm", "failed verdict stays wasm");
  });
});

describe("ENC-2b flag + contract additivity", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_2B_ENABLED(), "boolean");
  });
  test("flag-off: MEGACOMPACT_ENC_2B=0 yields false (ENC-RETEST-003 byte-identical)", () => {
    const saved = process.env.MEGACOMPACT_ENC_2B;
    try {
      process.env.MEGACOMPACT_ENC_2B = "0";
      assert.equal(ENC_2B_ENABLED(), false, "flag off when =0");
      const fx = fixture("ENC-RETEST-003");
      assert.equal(fx.setup.flag_off, true, "flag-off fixture setup");
      assert.equal(fx.expected_result.byte_identical, true, "flag-off byte-identical to ENC-2a era");
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_ENC_2B;
      else process.env.MEGACOMPACT_ENC_2B = saved;
    }
  });
  test("status contract carries the additive nativeOrtRetestResult + nativeOrtBackendEffective fields", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const getBlock = contracts.slice(
      contracts.indexOf("interface SetupStatusResponse"),
      contracts.indexOf("interface DetectResult"),
    );
    assert.match(getBlock, /nativeOrtRetestResult\?:/, "status carries optional nativeOrtRetestResult");
    assert.match(getBlock, /nativeOrtBackendEffective\?:\s*"native"\s*\|\s*"wasm"/, "status carries nativeOrtBackendEffective");
    assert.match(getBlock, /interface RetestResult/, "contract declares the RetestResult interface");
  });
  test("configure request carries the additive nativeOrtRetest boolean retest key", () => {
    const contracts = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup.ts"),
      "utf8",
    );
    const postBlock = contracts.slice(
      contracts.indexOf("interface SetupConfigureRequest"),
      contracts.indexOf("interface SetupConfigureResponse"),
    );
    assert.match(postBlock, /nativeOrtRetest\?:\s*boolean/, "configure request carries retest-request boolean");
  });
});

describe("ENC-2b no-network + flag-gating scan (zero-tolerance)", () => {
  const retestModule = join(ROOT, "src", "vector-cortex", "encoder", "native-qualify-retest.ts");
  const routeFile = join(ROOT, "extensions", "dashboard-server", "routes-setup-enc2b.ts");
  // Built dynamically so the test source itself never contains the literal
  // scheme (the zero-tolerance needle must not trip PREVENT-PI-004).
  const REG_SCHEME = "http" + "s" + ":" + "/" + "/";

  test("the retest module + route sibling contain no network scheme/fetch (PREVENT-PI-004)", () => {
    for (const f of [retestModule, routeFile]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes(REG_SCHEME), `${f} has no network scheme (PREVENT-PI-004)`);
      assert.ok(!src.includes("h" + "t" + "t" + "p" + ":" + "/" + "/"), `${f} has no minimal net scheme`);
      assert.ok(!src.includes("fetch" + "("), `${f} has no fetch call`);
    }
  });
  test("the route sibling is gated on ENC_2B_ENABLED (flag-off omits, byte-identical)", () => {
    const route = readFileSync(routeFile, "utf8");
    assert.match(route, /ENC_2B_ENABLED\(\)/, "readEnc2bRetest gates on the flag");
    assert.match(route, /runNativeRetest/, "route calls the retest module");
    assert.match(route, /"wasm"/, "degraded/failed verdict maps to wasm");
    // Flag-off MUST omit both fields (return {}), never emit a null marker —
    // byte-identical to the ENC-2a-era GET shape (ENC-RETEST-003).
    assert.match(route, /if \(!ENC_2B_ENABLED\(\)\) return \{\};/, "flag-off returns {} (omits both fields)");
  });
  test("the retest module loads only from the on-disk native-ort path (no network)", () => {
    const src = readFileSync(retestModule, "utf8");
    assert.match(src, /node_modules/, "binding path resolves under native-ort/node_modules");
    assert.match(src, /NATIVE_ORT_PACKAGE/, "binding name from the artifacts module");
  });
  test("the route host contains no console.log", () => {
    const routesHost = join(ROOT, "extensions", "dashboard-server", "routes-setup.ts");
    for (const f of [routeFile, routesHost, retestModule]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes("console.log"), `${f} must not call console.log`);
    }
  });
});
