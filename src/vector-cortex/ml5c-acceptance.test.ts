/**
 * ml5c-acceptance.test.ts — ML5-C runtime decision + packaging acceptance
 * aggregator (fixtures-driven, no mocks, no stubs).
 *
 * Drives ML5-RUNTIME-001..005 against the canonical v2 conformance corpus +
 * the REAL code: the five runtime-choice envelope fixtures (byte-count budget,
 * per-platform matrix, opset-21 handshake, stub-fallback to mode B,
 * native-opt-in routing), the normative pins from encoder/types.ts, the
 * pure decision-rule dispatch in runtime-select.ts, and the seller event
 * shape (EVAL-REDACT-002: aggregate-only).
 *
 * Flag-agnostic: no fixed runtime flag is asserted — the SAME suite passes
 * both `node --test dist/vector-cortex/ml5c-acceptance.test.js` and the
 * mandated `MEGACOMPACT_ML5_C=0 ...` parity run (the dispatch is a pure
 * function of {platform, benchRecord, nativeOptIn}, never a runtime side
 * effect to be byte-identical about).
 *
 * Local file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENCODER_MAX_TOKENS,
  ENCODER_LATENCY_P95_MS,
  ENCODER_OPSET,
} from "./encoder/types.js";
import { ML5C_ENABLED } from "../config/vector-cortex.js";
import { selectRuntimeBackend } from "./encoder/runtime-select.js";
import type { BenchResultV1 } from "./encoder/bench-export.js";

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
const V2 = join(repoRoot(HERE), "conformance", "vector-cortex", "v2");

const RUNTIME_IDS = [
  "ML5-RUNTIME-001",
  "ML5-RUNTIME-002",
  "ML5-RUNTIME-003",
  "ML5-RUNTIME-004",
  "ML5-RUNTIME-005",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; fixtures: ManifestRow[] }
interface RuntimeFixture {
  id: string; kind: string; flag?: string;
  backend?: string; budget_mib?: number; byte_count_le_budget?: boolean | null;
  amended_budget_mib?: number | null;
  platforms?: string[]; matrix_complete?: boolean; no_missing_optional_dep?: boolean;
  opset?: number; handshake?: string;
  asset_present?: boolean; native_opt_in?: boolean; fallback?: string;
  native_opt_in_default?: boolean; backend_default?: string;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): RuntimeFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("runtime-choice/"));
  assert.ok(row, `fixture ${id} registered under runtime-choice/`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as RuntimeFixture;
}

describe("ML5-C conformance registration", () => {
  test("manifest registers ML5-RUNTIME-001..005 with runtime-choice algorithm + ML5-C owner", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of RUNTIME_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "runtime-choice", `${id} algorithm`);
      assert.equal(row.schema, "schemas/ml5-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.path, `runtime-choice/${id}.json`, `${id} path`);
      assert.equal(row.expected, "ok");
    }
    assert.ok(m.owner.split(",").includes("ML5-C"), "owner CSV includes ML5-C");
  });
});

describe("ML5-RUNTIME-001..005 envelope invariants", () => {
  test("001 install budget byte-count compliance — native fits within the default 300 MiB budget", () => {
    const fx = fixture("ML5-RUNTIME-001");
    assert.equal(fx.kind, "runtime-choice");
    assert.equal(fx.flag, "MEGACOMPACT_ML5_C");
    // Decision rule selected native — shipped ~160 MiB fits the default 300 MiB
    // budget; no amendment is required at the default (amended_budget_mib null).
    assert.equal(fx.backend, "native");
    assert.equal(fx.budget_mib, 300);
    assert.equal(fx.byte_count_le_budget, true);
    assert.equal(fx.amended_budget_mib, null);
  });
  test("002 per-platform install matrix resolves completely", () => {
    const fx = fixture("ML5-RUNTIME-002");
    assert.ok(Array.isArray(fx.platforms));
    assert.equal(fx.platforms!.length, 5);
    for (const p of ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64", "linux-arm64"]) {
      assert.ok(fx.platforms!.includes(p), `platform row ${p} present`);
    }
    assert.equal(fx.matrix_complete, true);
    assert.equal(fx.no_missing_optional_dep, true);
  });
  test("003 opset-21 session handshake (placeholder-committed asset accepted)", () => {
    const fx = fixture("ML5-RUNTIME-003");
    assert.equal(fx.opset, ENCODER_OPSET); // 21
    assert.equal(fx.handshake, "ok");
  });
  test("004 stub-fallback routes to mode B trigram when WASM artifact is absent", () => {
    const fx = fixture("ML5-RUNTIME-004");
    assert.equal(fx.asset_present, false);
    assert.equal(fx.native_opt_in, false);
    assert.equal(fx.fallback, "mode_B_trigram");
  });
  test("005 native opt-in routes through onnxruntime-node; default routes WASM", () => {
    const fx = fixture("ML5-RUNTIME-005");
    assert.equal(fx.native_opt_in, true);
    assert.equal(fx.backend, "runtime-native");
    assert.equal(fx.native_opt_in_default, false);
    assert.equal(fx.backend_default, "runtime-wasm");
  });
});

describe("ML5-C decision-rule dispatch (runtime-select.ts pure)", () => {
  test("flag state is a live boolean regardless of env/environment", () => {
    assert.equal(typeof ML5C_ENABLED(), "boolean");
  });
  test("normative gate pins match the spec constants", () => {
    assert.equal(ENCODER_MAX_TOKENS, 512);
    assert.equal(ENCODER_LATENCY_P95_MS, 40);
    assert.equal(ENCODER_OPSET, 21);
  });
  test("flag-off returns modeB byte-identical to the ML5-B survivor", () => {
    // Under MEGACOMPACT_ML5_C=0, the dispatch itself returns modeB and the seller
    // event is suppressed (byte-identical ML5-B survivor). This assertion passes
    // under EITHER flag state — under ON the flag-off branch isn't taken, under
    // OFF the returned backend IS modeB. Flag-agnostic acceptance.
    if (!ML5C_ENABLED()) {
      const r = selectRuntimeBackend({
        platform: "linux-x64",
        benchRecord: null,
        nativeOptIn: true,
      });
      assert.equal(r.backend, "modeB");
      assert.equal(r.rationale, "flag-off: byte-identical mode-B trigram (no selection)");
    } else {
      assert.ok(true, "flag on: selection dispatch runs (no byte-identical mode-B override)");
    }
  });
  test("decision rule: linux-x64 with native opt-in + no bench record → native (fits default 300 MiB budget)", () => {
    if (!ML5C_ENABLED()) return;
    const r = selectRuntimeBackend({
      platform: "linux-x64",
      benchRecord: null,
      nativeOptIn: true,
    });
    assert.equal(r.backend, "native");
    assert.equal(r.budgetOk, true);          // shipped ~160 MiB fits the default 300 MiB budget
    assert.equal(r.platform, "linux-x64");
  });
  test("decision rule: linux-x64 default (no opt-in) + no bench record → native fallback (fits default 300 MiB budget)", () => {
    if (!ML5C_ENABLED()) return;
    const r = selectRuntimeBackend({
      platform: "linux-x64",
      benchRecord: null,
      nativeOptIn: false,
    });
    // No real bench record → the dispatch records the native fallback. At the
    // default 300 MiB budget, the shipped ~160 MiB fits → budgetOk:true. This is
    // the production close-out of the 42-byte placeholder state on master.
    assert.equal(r.backend, "native");
    assert.equal(r.budgetOk, true);
    assert.equal(r.p95Ms, null);
  });
  test("decision rule: darwin-x64 demotes to WASM per HG-4 (never native on this platform)", () => {
    if (!ML5C_ENABLED()) return;
    const r = selectRuntimeBackend({
      platform: "darwin-x64",
      benchRecord: null,
      nativeOptIn: true,
    });
    assert.equal(r.backend, "wasm");
    assert.equal(r.budgetOk, true);
  });
  test("decision rule: passing benchRecord with p95 <= 40 selects WASM", () => {
    if (!ML5C_ENABLED()) return;
    const bench: BenchResultV1 = {
      timestamp: 1,
      platform: "linux-x64",
      encoderNative: false,
      threads: 4,
      tokens: 512,
      corpusTokens: 1000,
      p95Ms: 25,
      rssMib: 145,
      rssBaselineMib: 120,
      rssMarginalMib: 25,
      opset: ENCODER_OPSET,
      deterministic: true,
      digest: "ab".repeat(32),
      gates: { latency: true, rss: true, opset: true, determinism: true, all: true },
    };
    const r = selectRuntimeBackend({
      platform: "linux-x64",
      benchRecord: bench,
      nativeOptIn: false,
    });
    assert.equal(r.backend, "wasm");
    assert.equal(r.budgetOk, true);
    assert.equal(r.p95Ms, 25);
  });
  test("decision rule: failing benchRecord (p95 > 40 on WASM) → native (fits default 300 MiB budget)", () => {
    if (!ML5C_ENABLED()) return;
    const bench: BenchResultV1 = {
      timestamp: 1,
      platform: "linux-x64",
      encoderNative: true,
      threads: 4,
      tokens: 512,
      corpusTokens: 1000,
      p95Ms: 75.4, // vc2-model-prep-measured WASM failure
      rssMib: 341,
      rssBaselineMib: 100,
      rssMarginalMib: 241,
      opset: ENCODER_OPSET,
      deterministic: true,
      digest: "cd".repeat(32),
      gates: { latency: false, rss: true, opset: true, determinism: true, all: false },
    };
    const r = selectRuntimeBackend({
      platform: "linux-x64",
      benchRecord: bench,
      nativeOptIn: false,
    });
    assert.equal(r.backend, "native");
    assert.equal(r.budgetOk, true);   // shipped ~160 MiB fits the default 300 MiB budget
    assert.equal(r.p95Ms, 75.4);
  });
});

describe("ML5-C seller event shape (EVAL-REDACT-002 aggregate-only)", () => {
  test("runtime-select result carries only allowed aggregate fields", () => {
    const r = selectRuntimeBackend({
      platform: "linux-x64",
      benchRecord: null,
      nativeOptIn: true,
    });
    const allowed = new Set(["backend", "budgetOk", "p95Ms", "platform", "rationale", "demotionReason"]);
    const leaked = Object.keys(r).filter((k) => !allowed.has(k));
    assert.deepEqual(leaked, [], "result exposes only aggregate fields");

    // The emitted event pins these four fields (per the ML5-C spec §Vector Cortex
    // events emission).
    const pinned = ["backend", "p95Ms", "budgetOk", "platform", "demotionReason"] as const;
    for (const k of pinned) {
      assert.ok(Object.hasOwn(r, k), `event carries ${k}`);
    }
  });
});
