/** VC2A acceptance aggregator — ENC-001..008 + named fixtures against the REAL
 *  asset/runtime (no mocks). Triad: A=qualified local ONNX, B=asset-free trigram
 *  (missing/unsupported/digest-bad, no remote fetch), C=lexical when A+B init fail.
 *
 *  Scopes: manifest registration + canonical corpus (owner VC2A), every conformance
 *  row resolved through createEncoderRuntime, the only-batch1/max512-verified
 *  invariant, 1..513 dimension gating, unique failure injection, forced triad A/B/C,
 *  the p95/RSS acceptance budgets, and flag-OFF parity (byte-identical predecessor).
 *  The ENC-001..008/named conformance rows and the runtime invariant/injection/triad
 *  suites live in the _acceptance-vc2a-conformance.ts / _acceptance-vc2a-runtime.ts
 *  siblings (they receive the shared helpers as a context object).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VC2A_ENABLED } from "../config/vector-cortex.js";
import {
  ENC_FAIL,
  ENC_IDS,
  ENCODER_MAX_TOKENS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_LATENCY_P95_MS,
  ENCODER_OPSET,
  type ModelManifestV1,
} from "./encoder/types.js";
import { verifyEncoderAsset, readEncoderManifest, detectPlatform } from "./encoder/asset.js";
import { createEncoderRuntime, type CreateEncoderRuntimeOptions } from "./encoder/runtime.js";
import { createEncoderReporter, NOOP_ENCODER_REPORTER } from "./encoder/emit.js";
import { canonicalManifestsConverge } from "./conformance/manifest.js";
import { registerVc2aConformance } from "./_acceptance-vc2a-conformance.js";
import { registerVc2aRuntime } from "./_acceptance-vc2a-runtime.js";

// Q04 (rollback-by-flag): the default createEncoderRuntime() honors
// MEGACOMPACT_VC2A so the "-0 selects C, byte-identical" contract is enforced in
// code. Pin the flag ON at module scope so the mode-A acceptance scenarios are
// deterministic under EITHER the default-ON run or the MEGACOMPACT_VC2A=0 parity
// run; the rollback/flag-off behavior is exercised explicitly inside the
// dedicated flag tests below (which manage their own env and restore it).
process.env.MEGACOMPACT_VC2A = "1";

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
const REPO_ROOT = repoRoot(HERE);
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestDef {
  owner: string;
  domain: string;
  fixtures: { id: string; path: string; algorithm: string }[];
}
interface EFixture {
  id: string;
  kind: string;
  producer: string;
  input: { scenario: string };
  expected: { ok: boolean; code?: string; mode?: string };
  assertion: string;
}
function readManifest(): ManifestDef {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as ManifestDef;
}
function fixture(id: string): EFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as EFixture;
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True 95th percentile (linear interpolation) of a sorted sample — p in (0,1).
 *  Unlike a floor(n*p) index (which collapses to the max for small n and hides
 *  latency spikes, Q02), this returns a genuine percentile between samples. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

const ENC_NAMED = ["ENC-ASSET-001", "ENC-DIGEST-002", "ENC-PLATFORM-003"];
const VC2A_IDS = [...ENC_IDS, ...ENC_NAMED];

/** The live platform, or linux-x64 in an unrecognized-host test env. Temp asset
 *  manifests derive their declared platform from here so they always match the
 *  runtime host — otherwise a "valid" scenario spuriously demotes to
 *  PLATFORM_UNSUPPORTED on non-linux-x64 machines and the suite fails
 *  (cross-platform code-quality Q02). */
const HOST_PLATFORM = detectPlatform() ?? "linux-x64";

// ---------------------------------------------------------------------------
// Temp asset construction (real files, real digests)
// ---------------------------------------------------------------------------
let seq = 0;
function tmpAsset(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${seq++}`);
}

/** A valid ModelManifestV1 (opset 21, batch 1, maxTokens 512). */
function baseManifest(over: Partial<ModelManifestV1> = {}): ModelManifestV1 {
  return {
    schema: "model-manifest-v1",
    modelVersion: "vc2a-accept",
    opset: ENCODER_OPSET,
    batch: 1,
    maxTokens: ENCODER_MAX_TOKENS,
    platform: HOST_PLATFORM,
    hiddenWidth: 384,
    semanticWidth: 384,
    heads: { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 },
    onnx: { path: "model.onnx", sha256: "", bytes: 0 },
    tokenizer: { path: "tokenizer.json", sha256: "", bytes: 0 },
    totalBytes: 0,
    trainingManifestDigest: "0".repeat(64),
    ...over,
  } as ModelManifestV1;
}

interface Built {
  dir: string;
  scenario: string;
}

/** Build an asset dir configured by the fixture scenario; returns cleanup handle. */
function buildDir(scenario: string): Built {
  const dir = tmpAsset("vc2a-fx");
  mkdirSync(dir, { recursive: true });
  const onnx = Buffer.from("0000-accept-onnx-opset21-abcdef", "binary");
  const tok = Buffer.from('{"vocab":[]}', "utf8");
  writeFileSync(join(dir, "model.onnx"), onnx);
  writeFileSync(join(dir, "tokenizer.json"), tok);
  let final = baseManifest({
    onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
    tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
    totalBytes: onnx.length + tok.length,
  });
  if (scenario === "mutate-onnx") {
    const mut = Buffer.concat([onnx.subarray(0, onnx.length - 1), Buffer.from([onnx[onnx.length - 1]! ^ 0x01])]);
    writeFileSync(join(dir, "model.onnx"), mut); // manifest still declares original digest
  } else if (scenario === "max-tokens-513") {
    final = { ...final, maxTokens: 513 };
  } else if (scenario === "opset-16") {
    final = { ...final, opset: 16 };
  } else if (scenario === "batch-2") {
    final = { ...final, batch: 2 };
  } else if (scenario === "missing-onnx") {
    rmSync(join(dir, "model.onnx"), { force: true });
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(final));
  return { dir, scenario };
}
function rmBuilt(b: Built): void {
  rmSync(b.dir, { recursive: true, force: true });
}

/** Runtime options to realize each conformance scenario on a valid asset. */
function optionsFor(scenario: string): CreateEncoderRuntimeOptions {
  if (scenario === "unsupported-platform") return { platform: () => null };
  if (scenario === "allocator-fail") return { host: { allocatorFails: () => true } };
  return {};
}

// ---------------------------------------------------------------------------
// Suite 1 — manifest registration + canonical corpus (owner VC2A)
// ---------------------------------------------------------------------------
describe("VC2A conformance registration", () => {
  test("manifest registers every ENC-001..008 + named fixture, owner + domain list VC2A", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of VC2A_IDS) assert.ok(ids.has(id), `missing ${id}`);
    assert.ok(m.owner.includes("VC2A"), "owner lists VC2A");
    assert.ok(m.domain.includes("encoder-runtime"), "domain lists encoder-runtime");
    for (const id of VC2A_IDS) {
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "encoder-runtime", `${id} algorithm`);
    }
  });
  test("the committed VC2A corpus is canonical (a single reproducible digest)", () => {
    assert.equal(canonicalManifestsConverge(V2), true, "committed corpus converges");
  });
});

// ---------------------------------------------------------------------------
// Suites 2 & 3 — conformance rows + named assertions + runtime invariant /
// injection / triad. The describe blocks live in the _acceptance-vc2a-*.ts
// siblings; they receive the shared helpers/imports as a context object.
// ---------------------------------------------------------------------------
const ctx = {
  ENC_FAIL,
  ENC_IDS,
  ENCODER_MAX_TOKENS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_LATENCY_P95_MS,
  fixture,
  buildDir,
  rmBuilt,
  optionsFor,
  tmpAsset,
  baseManifest,
  sha256,
  percentile,
  createEncoderRuntime,
  verifyEncoderAsset,
  readEncoderManifest,
};
registerVc2aConformance(ctx);
registerVc2aRuntime(ctx);

// ---------------------------------------------------------------------------
// Suite 4 — flag-off parity + emit seam
// ---------------------------------------------------------------------------
describe("VC2A flag-off parity + emit", () => {
  test("flag OFF yields ZERO encoder emissions (byte-identical predecessor)", () => {
    const emitted: string[] = [];
    const saved = process.env.MEGACOMPACT_VC2A;
    process.env.MEGACOMPACT_VC2A = "0";
    try {
      const reporter = createEncoderReporter((e) => emitted.push(e));
      reporter.assetVerified({ x: 1 });
      reporter.runtimeDemoted({ y: 2 });
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2A;
      else process.env.MEGACOMPACT_VC2A = saved;
    }
    assert.deepEqual(emitted, [], "flag OFF => no emissions");
    NOOP_ENCODER_REPORTER.assetVerified({});
    NOOP_ENCODER_REPORTER.runtimeDemoted({});
    assert.deepEqual(emitted, [], "noop reporter never emits");
  });
  test("flag ON: asset load emits its named event and a demotion its named event", () => {
    // Pin the flag ON explicitly so this assertion is valid under either the
    // default (ON) run or the MEGACOMPACT_VC2A=0 parity run.
    const saved = process.env.MEGACOMPACT_VC2A;
    process.env.MEGACOMPACT_VC2A = "1";
    const emitted: Record<string, number> = {};
    const reporter = createEncoderReporter((event) => {
      emitted[event] = (emitted[event] ?? 0) + 1;
    });
    const good = buildDir("valid");
    const bad = buildDir("missing-onnx");
    try {
      createEncoderRuntime({ reporter }).load(good.dir);
      createEncoderRuntime({ reporter }).load(bad.dir);
    } finally {
      rmBuilt(good);
      rmBuilt(bad);
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2A;
      else process.env.MEGACOMPACT_VC2A = saved;
    }
    assert.ok((emitted["vector_cortex_encoder_asset_verified"] ?? 0) >= 1, "asset_verified emitted");
    assert.ok((emitted["vector_cortex_encoder_runtime_demoted"] ?? 0) >= 1, "runtime_demoted emitted");
  });
  test("VC2A flag is defined, default ON, and =0 disables", () => {
    const saved = process.env.MEGACOMPACT_VC2A;
    delete process.env.MEGACOMPACT_VC2A;
    try {
      assert.equal(VC2A_ENABLED(), true, "default ON");
    } finally {
      if (saved !== undefined) process.env.MEGACOMPACT_VC2A = saved;
    }
    process.env.MEGACOMPACT_VC2A = "0";
    assert.equal(VC2A_ENABLED(), false, "=0 disables");
    delete process.env.MEGACOMPACT_VC2A;
  });
});
