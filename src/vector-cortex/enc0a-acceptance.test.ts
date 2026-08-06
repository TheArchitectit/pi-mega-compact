/** ENC-0a backend-decision acceptance aggregator (fixtures-driven, no mocks).
 *  Drives ENC-DEC-001..006 against the canonical v2 corpus + the real resolver.
 *  Opset baseline pinned to 21; darwin-x64 demotion "wasm" (HG-4).
 *  Flag-agnostic: same suite passes under `MEGACOMPACT_ENC_0A=0` parity run.
 *  Local subprocess + file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENC_0A_ENABLED } from "../config/vector-cortex.js";
import {
  buildDecision,
  ENCODER_INSTALL_BUDGET_MIB,
  type EncoderBackendDecisionV1,
  type EncoderPlatformRow,
} from "./encoder/decision.js";
import { registerEnc0aContract } from "./_acceptance-enc0a-contract.js";

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
const RESOLVER = join(ROOT, "scripts", "encoder", "resolve-backend-decision.mjs");

const ENC_DEC_IDS = [
  "ENC-DEC-001",
  "ENC-DEC-002",
  "ENC-DEC-003",
  "ENC-DEC-004",
  "ENC-DEC-005",
  "ENC-DEC-006",
] as const;

/** The 5 EncoderPlatform values (from encoder/types.ts). */
const PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; domain: string; fixtures: ManifestRow[] }
interface EncDecisionFixture {
  id: string;
  producer: string;
  assertion: string;
  kind: string;
  bench_input: Record<string, unknown> | null;
  expected_decision: EncoderBackendDecisionV1 | null;
  expected_outcome: "ok" | "error";
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): EncDecisionFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("encoder-decision/"));
  assert.ok(row, `fixture ${id} registered under encoder-decision/`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as EncDecisionFixture;
}

/**
 * Invoke the resolver for a fixture: materialize bench_input (when non-null) as a
 * one-row JSONL and pass it via --bench, otherwise degrade (no --bench). Returns
 * the child's exit code + stdout/stderr; the temp bench file is always removed.
 */
function runResolver(id: string): { status: number; stdout: string; stderr: string } {
  const fx = fixture(id);
  const args = [RESOLVER];
  let tmp: string | null = null;
  if (fx.bench_input !== null) {
    tmp = join(ROOT, ".tmp-enc0a-" + id + ".jsonl");
    writeFileSync(tmp, JSON.stringify(fx.bench_input) + "\n");
    args.push("--bench", tmp);
  }
  const r = spawnSync("node", args, {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
  });
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("ENC-0a conformance registration", () => {
  test("manifest registers ENC-DEC-001..006 + the schema under the encoder-decision seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_DEC_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "encoder-decision", `${id} algorithm`);
      assert.equal(row.schema, "schemas/encoder-decision-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.path, `encoder-decision/${id}.json`, `${id} path`);
      assert.equal(row.expected, id === "ENC-DEC-005" ? "error" : "ok", `${id} manifest expected`);
    }
    const schemaRow = m.fixtures.find((f) => f.path === "schemas/encoder-decision-fixture.schema.json");
    assert.ok(schemaRow, "encoder-decision schema registered");
    assert.equal(schemaRow!.algorithm, "json-schema");
    assert.ok(m.owner.split(",").includes("ENC-0a"), "owner CSV includes ENC-0a");
    assert.ok(m.domain.split(";").includes("encoder-decision"), "domain includes encoder-decision");
  });
});

describe("ENC-DEC fixture envelopes", () => {
  test("the 6 kinds are closed to the spec branch set and carry a producer + assertion", () => {
    const kinds = new Set<string>();
    for (const id of ENC_DEC_IDS) {
      const fx = fixture(id);
      assert.equal(fx.producer, "ml5-enc/gen-fixtures.mjs", `${id}: producer`);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.ok(["ok", "error"].includes(fx.expected_outcome), `${id}: outcome enum`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "wasm-qualified",
      "native-amended",
      "opset-pinned",
      "platform-matrix",
      "sha256-mismatch",
      "degraded-baseline",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present across the 6 fixtures`);
    }
  });

  test("every non-error expected_decision is a well-formed EncoderBackendDecisionV1 (opset 21, complete matrix, MIT)", () => {
    for (const id of ENC_DEC_IDS) {
      const fx = fixture(id);
      if (fx.expected_decision === null) {
        assert.equal(fx.expected_outcome, "error", `${id}: null decision only on error`);
        continue;
      }
      const d: EncoderBackendDecisionV1 = fx.expected_decision;
      assert.equal(d.schema, "encoder-backend-decision-v1", `${id}: schema`);
      assert.equal(d.opset, 21, `${id}: opset pinned 21 (ENC-0a re-baseline)`);
      assert.ok(["wasm", "native"].includes(d.backend), `${id}: backend enum`);
      assert.equal(typeof d.budgetOk, "boolean", `${id}: budgetOk boolean`);
      assert.deepEqual(d.license, { spdx: "MIT", redistribution: true }, `${id}: MIT license`);
      for (const p of PLATFORMS) {
        const row: EncoderPlatformRow = d.platformMatrix[p];
        assert.ok(row, `${id}: platform ${p} row present`);
        assert.ok(row.runtime.length > 0, `${id}: ${p} runtime`);
        assert.ok(["none", "wasm", "modeB"].includes(row.demotion), `${id}: ${p} demotion enum`);
      }
      assert.equal(d.platformMatrix["darwin-x64"].demotion, "wasm", `${id}: darwin-x64 demotes to wasm (HG-4)`);
      assert.ok(d.artifacts.model.sha256.length === 64, `${id}: model pin is 64-hex`);
      assert.ok(d.artifacts.tokenizer.sha256.length === 64, `${id}: tokenizer pin is 64-hex`);
      assert.ok(Array.isArray(d.blockedBy), `${id}: blockedBy array`);
    }
  });

  test("budget constant is 80 MiB (MODEL_ASSET install cap)", () => {
    assert.equal(ENCODER_INSTALL_BUDGET_MIB, 80);
  });
});

describe("resolver decision branches (real resolver subprocess)", () => {
  test("ENC-DEC-001 wasm-qualified: p95<=40 + bytes<=80 -> wasm, budgetOk true", () => {
    const fx = fixture("ENC-DEC-001");
    const { status, stdout } = runResolver("ENC-DEC-001");
    assert.equal(status, 0, "ok outcome exits 0");
    assert.deepEqual(JSON.parse(stdout), fx.expected_decision);
  });

  test("ENC-DEC-002 native-amended: p95>40 -> native, budgetOk false", () => {
    const fx = fixture("ENC-DEC-002");
    const { status, stdout } = runResolver("ENC-DEC-002");
    assert.equal(status, 0);
    const d = JSON.parse(stdout) as EncoderBackendDecisionV1;
    assert.equal(d.backend, "native");
    assert.equal(d.budgetOk, false);
    assert.equal(d.p95Ms, 54.7);
    assert.deepEqual(d, fx.expected_decision);
  });

  test("ENC-DEC-003 opset-pinned: decision.opset is exactly 21", () => {
    const fx = fixture("ENC-DEC-003");
    const { status, stdout } = runResolver("ENC-DEC-003");
    assert.equal(status, 0);
    const d = JSON.parse(stdout) as EncoderBackendDecisionV1;
    assert.equal(d.opset, 21);
    assert.deepEqual(d, fx.expected_decision);
  });

  test("ENC-DEC-004 platform-matrix: every EncoderPlatform resolves; darwin-x64 -> wasm demotion", () => {
    const fx = fixture("ENC-DEC-004");
    const { status, stdout } = runResolver("ENC-DEC-004");
    assert.equal(status, 0);
    const d = JSON.parse(stdout) as EncoderBackendDecisionV1;
    for (const p of PLATFORMS) assert.ok(d.platformMatrix[p], `row for ${p}`);
    assert.equal(d.platformMatrix["darwin-x64"].demotion, "wasm");
    assert.deepEqual(d, fx.expected_decision);
  });

  test("ENC-DEC-005 sha256-mismatch: bench model_sha256 mismatch FAILS the resolver (supply-chain guard)", () => {
    const r = runResolver("ENC-DEC-005");
    assert.notEqual(r.status, 0, "mismatch exits non-zero (error outcome)");
    assert.match(r.stderr, /encoder_backend_decision_failed/, "structured failure event on stderr");
    assert.match(r.stderr, /sha256/, "failure names the sha256 guard");
  });

  test("ENC-DEC-006 degraded-baseline: no bench -> resolver degrades and still emits wasm, budgetOk true, p95Ms null", () => {
    const fx = fixture("ENC-DEC-006");
    const { status, stdout } = runResolver("ENC-DEC-006");
    assert.equal(status, 0, "never blocks on absent measurement");
    const d = JSON.parse(stdout) as EncoderBackendDecisionV1;
    assert.equal(d.backend, "wasm");
    assert.equal(d.budgetOk, true);
    assert.equal(d.p95Ms, null);
    assert.ok(d.blockedBy.length > 0, "degraded decision records the unmeasured-p95 reason");
    assert.deepEqual(d, fx.expected_decision);
  });

  test("the resolver emits one structured log line per invocation (event: encoder_backend_decision_resolved)", () => {
    const { stderr } = runResolver("ENC-DEC-001");
    const line = stderr.trim().split("\n").find((l) => l.includes('"encoder_backend_decision_resolved"'));
    assert.ok(line, "resolved event present");
    const ev = JSON.parse(line!);
    assert.equal(ev.event, "encoder_backend_decision_resolved");
    assert.equal(ev.backend, "wasm");
    assert.equal(ev.opset, 21);
    assert.equal(typeof ev.ts, "number");
  });
});

// buildDecision contract suite lives in _acceptance-enc0a-contract.ts (soft-limit).
registerEnc0aContract({ buildDecision, PLATFORMS });

describe("flag semantics", () => {
  test("flag exports a live boolean regardless of env state (aggregator flag-agnostic)", () => {
    // The suite is green under BOTH default-ON and MEGACOMPACT_ENC_0A=0 parity runs.
    assert.equal(typeof ENC_0A_ENABLED(), "boolean");
  });

  test("flag-off byte-identity: the resolver output is byte-identical under both flag states", () => {
    // The resolver is a pure local script gated by NO runtime flag: ENC-0a's
    // decision-record wiring is a manual/script action (no runtime side effect
    // writes a decision file this sprint). Under MEGACOMPACT_ENC_0A=0 the flag is
    // false and no decision file is written by any runtime path; the resolver,
    // when invoked directly, emits the IDENTICAL decision bytes either way.
    const on = execFileSync("node", [RESOLVER], { encoding: "utf8", cwd: ROOT });
    const off = execFileSync("node", [RESOLVER], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, MEGACOMPACT_ENC_0A: "0" },
    });
    assert.equal(off, on, "resolver decision bytes are byte-identical under MEGACOMPACT_ENC_0A=0");
    if (!ENC_0A_ENABLED()) {
      // Under the parity run, additionally assert the degraded decision still resolves
      // to the recorded WASM baseline (never blocks on the absent measurement).
      const d = JSON.parse(on) as EncoderBackendDecisionV1;
      assert.equal(d.budgetOk, true);
    }
  });
});
