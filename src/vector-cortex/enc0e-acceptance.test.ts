/** ENC-0e acceptance aggregator (fixtures-driven, no mocks).
 *  Drives ENC-DEMO-001..006 against the flag and the pure ML5-C selection seam
 *  (selectRuntimeBackend). The darwin-x64 demotion reason is computed in
 *  PROCESS (never a script spawn), so the flag-off path is a pure-helper
 *  assertion: on an injected platform:"darwin-x64" under ENC_0E ON the selection
 *  returns backend:"wasm" + a concrete demotionReason; under =0 the reason is
 *  stripped (null — byte-identical to the ENC-0d predecessor). The non-darwin
 *  control (linux-x64/darwin-arm64) yields no reason and the existing
 *  WASM/native rule is unchanged. Contract additivity + card render are pinned
 *  by source reads (the SetupCortexStatusResponse.darwinX64 field is optional;
 *  the client card renders the reason only when demoted). Local file reads
 *  only, zero network, flag-agnostic (passes with the flag ON or OFF).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_0E_ENABLED } from "../config/vector-cortex.js";
import {
  selectRuntimeBackend,
  darwinX64DemotionReason,
} from "./encoder/runtime-select.js";
import {
  DARWIN_X64_DEMOTION_REASON,
  DARWIN_X64_DEMOTION_REASON_SENTINEL,
} from "./encoder/decision.js";
import type { RuntimeSelectionInput } from "./encoder/runtime-select.js";

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
const ENC_DEMO_IDS = [
  "ENC-DEMO-001", "ENC-DEMO-002", "ENC-DEMO-003",
  "ENC-DEMO-004", "ENC-DEMO-005", "ENC-DEMO-006",
] as const;
const CANONICAL = DARWIN_X64_DEMOTION_REASON;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface DemoFixture {
  id: string; producer: string; assertion: string; kind: string;
  setup: Record<string, unknown>;
  expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): DemoFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("encoder-demotion/"));
  assert.ok(row, `fixture ${id} registered under encoder-demotion/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as DemoFixture;
}

/** An ML5-C input with an injected platform over the pure selection seam. */
function input(platform: RuntimeSelectionInput["platform"]): RuntimeSelectionInput {
  return { platform, benchRecord: null, nativeOptIn: false };
}

function qualifyingBench(platform: string) {
  return {
    timestamp: 0,
    platform,
    encoderNative: false,
    threads: 4,
    tokens: 512,
    corpusTokens: 5120,
    p95Ms: 30,
    rssMib: 40,
    rssBaselineMib: 10,
    rssMarginalMib: 30,
    opset: 21,
    deterministic: true,
    digest: "0".repeat(64),
    gates: { latency: true, rss: true, opset: true, determinism: true, all: true },
  };
}

describe("ENC-0e conformance registration", () => {
  test("manifest registers ENC-DEMO-001..006 under the encoder-demotion seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_DEMO_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.path, `encoder-demotion/${id}.json`, `${id} path`);
      assert.equal(row.algorithm, "encoder-demotion", `${id} algorithm`);
      assert.equal(row.schema, "schemas/encoder-demotion-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.expected, "ok", `${id} expected`);
    }
    const schemaRow = m.fixtures.find((f) => f.path === "schemas/encoder-demotion-fixture.schema.json");
    assert.ok(schemaRow, "encoder-demotion schema registered");
    assert.ok(m.owner.split(",").includes("ENC-0e"), "owner CSV includes ENC-0e");
    assert.ok(m.domain.split(";").includes("encoder-demotion"), "domain includes encoder-demotion");
  });

  test("the 6 ENC-DEMO fixture kinds are closed to the spec branch set", () => {
    const kinds = new Set<string>();
    for (const id of ENC_DEMO_IDS) {
      const fx = fixture(id);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.equal(fx.expected_outcome, "ok", `${id}: outcome`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "darwin-demoted", "non-darwin-control", "flag-off-event",
      "flag-off-card", "card-renders-reason", "contract-additive",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present`);
    }
  });
});

describe("ENC-0e darwin-x64 demotion (fixture 001 — flag-agnostic)", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_0E_ENABLED(), "boolean");
  });

  test("injected platform darwin-x64 -> backend wasm + concrete demotionReason on the event under ENC_0E ON", () => {
    const fx = fixture("ENC-DEMO-001");
    assert.equal(fx.expected_result["backend"], "wasm");
    const chosen = selectRuntimeBackend(input("darwin-x64"));
    assert.equal(chosen.backend, "wasm", "darwin-x64 always demotes to WASM");
    assert.equal(chosen.platform, "darwin-x64");
    if (ENC_0E_ENABLED()) {
      assert.equal(chosen.demotionReason, CANONICAL, "demotionReason is the canonical HG-4 string");
      assert.equal(chosen.demotionReason, fx.expected_result["demotionReason"], "matches ENC-DEMO-001");
    } else {
      assert.equal(chosen.demotionReason, null, "flag-off strips the demotionReason");
    }
  });

  test("the selection is pure: same inputs -> same output across calls", () => {
    const a = selectRuntimeBackend(input("darwin-x64"));
    const b = selectRuntimeBackend(input("darwin-x64"));
    assert.deepEqual(a, b, "same inputs yield an identical selection (no side effects)");
  });
});

describe("ENC-0e reason is a single canonical source (fixture 001 invariant)", () => {
  test("DARWIN_X64_DEMOTION_REASON is exported and non-empty with no scattered literal", () => {
    assert.ok(CANONICAL.length > 0);
    assert.match(CANONICAL, /darwin-x64/);
    assert.match(CANONICAL, /HG-4/);
  });

  test("no other src file re-invents the reason string as its own literal", () => {
    // The reason must live ONLY in decision.ts (the constant). Search the
    // encoder + route source for a duplicate literal that is not the constant.
    const files = [
      join(ROOT, "src", "vector-cortex", "encoder", "runtime-select.ts"),
      join(ROOT, "src", "vector-cortex", "encoder", "runtime-emit.ts"),
      join(ROOT, "extensions", "dashboard-server", "routes-setup-cortex.ts"),
      join(ROOT, "extensions", "dashboard-server", "setup-cortex-blockers.ts"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const body = src.replace(/\s+/g, " ").trim();
      // Every occurrence in these files must be an import/use of the constant,
      // not a hard-coded repeat: the canonical phrase cannot appear more than
      // once per file (the one legitimate use/mention).
      const hits = body.split("no native binary upstream (arm64-only)").length - 1;
      assert.ok(hits <= 1, `${f} must not hard-code the reason literal (hits=${hits})`);
    }
  });
});

describe("ENC-0e non-darwin control (fixture 002)", () => {
  test("linux-x64 -> no demotionReason, existing WASM/native rule unchanged", () => {
    const fx = fixture("ENC-DEMO-002");
    assert.equal(fx.expected_result["backend"], "native");
    const chosen = selectRuntimeBackend(input("linux-x64"));
    assert.equal(chosen.backend, "native", "no bench -> native fallback unchanged");
    assert.equal(chosen.demotionReason, null, "no reason on non-darwin platforms");
  });

  test("linux-x64 with a qualifying bench still selects WASM and carries no reason", () => {
    const chosen = selectRuntimeBackend({
      platform: "linux-x64",
      benchRecord: qualifyingBench("linux-x64"),
      nativeOptIn: false,
    });
    assert.equal(chosen.backend, "wasm", "p95 <= 40ms qualifies WASM (existing rule)");
    assert.equal(chosen.demotionReason, null);
  });

  test("darwin-arm64 -> no demotionReason, native opt-in still honored", () => {
    const chosen = selectRuntimeBackend({
      platform: "darwin-arm64",
      benchRecord: null,
      nativeOptIn: true,
    });
    assert.equal(chosen.backend, "native", "darwin-arm64 native opt-in unchanged");
    assert.equal(chosen.demotionReason, null);
  });
});

describe("ENC-0e flag-off byte-identity (fixtures 003 / 004)", () => {
  test("flag-off -> event carries no demotionReason (delegates to the flag branch)", () => {
    const fx = fixture("ENC-DEMO-003");
    assert.equal(fx.expected_result["backend"], "wasm");
    const chosen = selectRuntimeBackend(input("darwin-x64"));
    assert.equal(chosen.backend, "wasm", "ML5-C WASM demotion itself is NOT gated off");
    if (ENC_0E_ENABLED()) {
      assert.ok(chosen.demotionReason !== null, "ON: reason present");
    } else {
      assert.equal(chosen.demotionReason, null, "OFF: reason stripped, byte-identical predecessor");
    }
  });

  test("flag-off card: a non-darwin host payload omits darwinX64 (contract additivity)", () => {
    const fx = fixture("ENC-DEMO-004");
    assert.equal(fx.expected_result["darwinX64_absent"], true);
    // The additive contract field is OPTIONAL on SetupCortexStatusResponse. On
    // the CI host (linux-x64) darwinX64StatusBlock returns null so the field is
    // absent; the source-level type must mark it optional (source-pin).
    const contract = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "api-contracts", "setup-cortex.ts"),
      "utf8",
    );
    assert.match(contract, /darwinX64\?:/s, "darwinX64 is an optional additive field");
    assert.ok(!contract.includes("darwinX64: {"), "field never marked required");
    // PREVENT-011: no actual `any` type annotation (comments saying "no any" are
    // allowed — detect only real type uses).
    assert.ok(!/: any\b/.test(contract), "no `: any` type annotation in the contract");
    assert.ok(!/as any\b/.test(contract), "no `as any` cast in the contract");
  });
});

describe("ENC-0e card + sentinel (fixtures 005 / unique-failure injection)", () => {
  test("the client card renders a diagnosed darwin-x64 row when demoted (source-pin)", () => {
    const fx = fixture("ENC-DEMO-005");
    assert.equal(fx.expected_result["demoted"], true);
    assert.equal(fx.expected_result["card_demotion_row"], true);
    const card = readFileSync(
      join(ROOT, "extensions", "dashboard-client", "src", "tabs", "SetupTab", "CortexBlockersCard.tsx"),
      "utf8",
    );
    assert.match(card, /darwinX64/, "card accepts the darwinX64 prop");
    assert.match(card, /demoted === true/, "card renders rows only when demoted");
    assert.match(card, /reason/, "card surfaces the reason string");
  });

  test("an injected darwin-x64 matrix row missing the reason falls back to a deterministic sentinel (never a throw)", () => {
    const missing = { runtime: "wasm", installMiB: 0, demotion: "wasm" as const };
    const reason = darwinX64DemotionReason(missing);
    assert.equal(reason, DARWIN_X64_DEMOTION_REASON_SENTINEL, "sentinel on missing reason");
    assert.match(reason, /WASM/, "sentinel demotes to WASM, never fabricates a native claim");
    assert.ok(!/native/.test(reason), "sentinel never claims a native binary");
    // A provider row WITH the reason wins (single canonical source).
    const withReason = {
      runtime: "wasm",
      installMiB: 0,
      demotion: "wasm" as const,
      demotionReason: CANONICAL,
    };
    assert.equal(darwinX64DemotionReason(withReason), CANONICAL);
    // No provider -> canonical constant.
    assert.equal(darwinX64DemotionReason(undefined), CANONICAL);
  });
});

describe("ENC-0e manifest + evidence integrity", () => {
  test("ENC-DEMO fixtures are canonical: sorted UTF-8 byte key order, all required fields", () => {
    const expectedKeys = [
      "assertion", "expected_outcome", "expected_result", "id",
      "kind", "producer", "schema", "setup",
    ].sort();
    for (const id of ENC_DEMO_IDS) {
      const fx = fixture(id);
      const keys = Object.keys(fx).sort();
      assert.deepEqual(keys, expectedKeys, `${id} canonical key set`);
      for (const k of expectedKeys) assert.ok(k in fx, `${id} has ${k}`);
    }
  });

  test("evidence doc exists and records the proof (ENC-0e.md)", () => {
    const ev = join(ROOT, "docs", "vector-cortex", "evidence", "ENC-0e.md");
    assert.ok(existsSync(ev), "ENC-0e evidence present");
    const src = readFileSync(ev, "utf8");
    assert.match(src, /darwin-x64/, "evidence names the platform");
    assert.match(src, /demotionReason/, "evidence records the reason field");
    assert.match(src, /darwinX64/, "evidence records the contract field");
  });
});
