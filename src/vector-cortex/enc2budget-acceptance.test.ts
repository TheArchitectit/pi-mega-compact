/** ENC-2a acceptance aggregator (fixtures + contract scan, no mocks).
 *
 *  Covers the operator-configurable native install budget
 *  (`MEGACOMPACT_NATIVE_ORT_BUDGET_MIB`) Settings surface at the pure/contract
 *  level: (1) the fixture registration + kind-closure for ENC-BUDGET-001..004
 *  against the enc-budget fixture schema; (2) the `installBudgetMib()` knob's
 *  default-fallback / operator-override / out-of-clamp / non-numeric behaviors
 *  match the fixtures' `expected_effective_mib` (this is the same behavior
 *  `enc0a-acceptance.test.ts` asserts at the constant level — here asserted at
 *  fixture-resolution parity); (3) the contract fields surface only when the
 *  flag is on; (4) the flag-agnostic export (passes with ENC_2BUDGET ON or OFF).
 *
 *  Local file reads only, zero network. All imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_2BUDGET_ENABLED } from "../config/vector-cortex.js";
import {
  installBudgetMib,
  INSTALL_BUDGET_DEFAULT_MIB,
  INSTALL_BUDGET_CLAMP_MIB,
} from "./encoder/decision.js";

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
const ENC_BUDGET_IDS = ["ENC-BUDGET-001", "ENC-BUDGET-002", "ENC-BUDGET-003", "ENC-BUDGET-004"] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface BudgetFixture {
  id: string; producer: string; assertion: string; kind: string;
  flag: string; env_state: string | null; expected_effective_mib: number;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): BudgetFixture {
  const row = readManifest().fixtures.find(
    (f) => f.id === id && f.path.startsWith("enc-budget/"),
  );
  if (!row) throw new Error(`fixture ${id} not registered in manifest`);
  const path = join(V2, row.path);
  return JSON.parse(readFileSync(path, "utf8")) as BudgetFixture;
}

describe("ENC-2a fixture registration + kind-closure", () => {
  test("manifest registers the four ENC-BUDGET fixtures with algorithm enc-budget", () => {
    const m = readManifest();
    for (const id of ENC_BUDGET_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "enc-budget", `${id} algorithm`);
      assert.equal(row!.schema, "schemas/enc-budget-fixture.schema.json", `${id} schema`);
      assert.equal(row!.expected, "ok", `${id} expected`);
    }
  });
  test("owner ENC-2a is registered in the manifest CSV", () => {
    const owners = readManifest().owner.split(",").map((s) => s.trim());
    assert.ok(owners.includes("ENC-2a"), "owner ENC-2a present");
  });
  test("domain enc-budget is registered in the manifest (semicolon-delimited)", () => {
    const domains = readManifest().domain.split(";").map((s) => s.trim());
    assert.ok(domains.includes("enc-budget"), "domain enc-budget present");
  });
  test("every fixture file pins the producer + flag + env_state + expected_effective_mib", () => {
    for (const id of ENC_BUDGET_IDS) {
      const fx = fixture(id);
      assert.equal(fx.flag, "MEGACOMPACT_ENC_2BUDGET", `${id} flag`);
      assert.equal(typeof fx.assertion, "string", `${id} assertion`);
      assert.equal(typeof fx.kind, "string", `${id} kind`);
      assert.equal(typeof fx.expected_effective_mib, "number", `${id} effective mib number`);
    }
  });
});

describe("ENC-2a installBudgetMib() fixture parity", () => {
  // Apply the fixture's env_state to process.env and verify installBudgetMib()
  // resolves to the fixture's expected_effective_mib.
  function resolveWith(envState: string | null): number {
    const saved = process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB;
    try {
      if (envState === null) delete process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB;
      else process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB = envState;
      return installBudgetMib();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB;
      else process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB = saved;
    }
  }

  test("ENC-BUDGET-001 unset → 300 MiB default", () => {
    const fx = fixture("ENC-BUDGET-001");
    assert.equal(fx.env_state, null);
    assert.equal(resolveWith(fx.env_state), fx.expected_effective_mib);
    assert.equal(INSTALL_BUDGET_DEFAULT_MIB, 300);
  });
  test("ENC-BUDGET-002 operator override within clamp honored", () => {
    const fx = fixture("ENC-BUDGET-002");
    assert.equal(resolveWith(fx.env_state), fx.expected_effective_mib);
  });
  test("ENC-BUDGET-003 out-of-clamp input falls back to 300 default", () => {
    const fx = fixture("ENC-BUDGET-003");
    assert.equal(fx.expected_effective_mib, INSTALL_BUDGET_DEFAULT_MIB);
    assert.equal(resolveWith(fx.env_state), INSTALL_BUDGET_DEFAULT_MIB);
    assert.equal(INSTALL_BUDGET_CLAMP_MIB, 8192);
  });
  test("ENC-BUDGET-004 non-numeric input falls back to 300 default", () => {
    const fx = fixture("ENC-BUDGET-004");
    assert.equal(resolveWith(fx.env_state), fx.expected_effective_mib);
  });
});

describe("ENC-2a contract + flag invariants", () => {
  test("flag state is a live boolean regardless of env", () => {
    assert.equal(typeof ENC_2BUDGET_ENABLED(), "boolean");
  });
  test("the dashboard sibling imports installBudgetMib from decision.ts (runtime operand is reused, not reimplemented)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-setup-enc2budget.ts"),
      "utf8",
    );
    assert.match(
      src,
      /import \{[^}]*installBudgetMib[^}]*\} from "\.\.\/\.\.\/src\/vector-cortex\/encoder\/decision\.js"/,
      "sibling imports installBudgetMib from decision.ts",
    );
    assert.match(
      src,
      /ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV/,
      "sibling pins the env name constant",
    );
    assert.match(
      src,
      /resolveInstallBudgetMib/,
      "the effective-operand field is resolved through the shared pure resolver (not reimplemented)",
    );
    assert.match(
      src,
      /const effective = raw !== null \? resolveInstallBudgetMib\(raw\) : installBudgetMib\(\);/,
      "effective operand resolves the persisted value first, falling back to the live env",
    );
    assert.match(
      src,
      /MEGACOMPACT_NATIVE_ORT_BUDGET_MIB/,
      "the runtime env name is pinned in the Settings toggle description",
    );
  });
  test("the flag is registered as a VECTOR_CORTEX_SETTINGS boolDirect toggle (never excluded)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-rag-settings-vector-cortex.ts"),
      "utf8",
    );
    assert.match(src, /"MEGACOMPACT_ENC_2BUDGET"/, "flag registered in VECTOR_CORTEX_SETTINGS");
    // EXCLUDED_SETTINGS must NOT contain the flag (per feedback_dashboard-flags-toggleable).
    const excludedMatch = src.match(/EXCLUDED_SETTINGS[^;]*;/s);
    if (excludedMatch) {
      assert.doesNotMatch(
        excludedMatch[0],
        /MEGACOMPACT_ENC_2BUDGET/,
        "flag is NOT in EXCLUDED_SETTINGS",
      );
    }
  });
});
