/** VC2A acceptance aggregator — ENC-001..008 + named fixtures against the REAL
 *  asset/runtime (no mocks). Triad: A=qualified local ONNX, B=asset-free trigram
 *  (missing/unsupported/digest-bad, no remote fetch), C=lexical when A+B init fail.
 *
 *  Scopes: manifest registration + canonical corpus (owner VC2A), every conformance
 *  row resolved through createEncoderRuntime, the only-batch1/max512-verified
 *  invariant, 1..513 dimension gating, unique failure injection, forced triad A/B/C,
 *  the p95/RSS acceptance budgets, and flag-OFF parity (byte-identical predecessor).
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
  type ModelManifestV1,
  type EncoderLoadResult,
} from "./encoder/types.js";
import { verifyEncoderAsset, readEncoderManifest, detectPlatform } from "./encoder/asset.js";
import { createEncoderRuntime, type CreateEncoderRuntimeOptions } from "./encoder/runtime.js";
import { createEncoderReporter, NOOP_ENCODER_REPORTER } from "./encoder/emit.js";
import { canonicalManifestsConverge } from "./conformance/manifest.js";

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

/** A valid ModelManifestV1 (opset 17, batch 1, maxTokens 512). */
function baseManifest(over: Partial<ModelManifestV1> = {}): ModelManifestV1 {
  return {
    schema: "model-manifest-v1",
    modelVersion: "vc2a-accept",
    opset: 17,
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
  const onnx = Buffer.from("0000-accept-onnx-opset17-abcdef", "binary");
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
// Suite 2 — ENC-001..008 conformance rows through the real runtime
// ---------------------------------------------------------------------------
describe("ENC-001..008 conformance rows", () => {
  for (const id of ENC_IDS) {
    test(`${id}: resolves through the real runtime to the documented result`, () => {
      const fx = fixture(id);
      const built = buildDir(fx.input.scenario);
      try {
        const rt = createEncoderRuntime(optionsFor(fx.input.scenario));
        const load: EncoderLoadResult = rt.load(built.dir);
        assert.equal(load.ok, fx.expected.ok, `${id} ok`);
        if (!load.ok) {
          assert.equal(load.code, fx.expected.code, `${id} exact failure code`);
          if (fx.expected.mode) assert.equal(load.mode, fx.expected.mode, `${id} mode`);
        } else {
          assert.equal(load.mode, "A", `${id} should be mode A`);
        }
      } finally {
        rmBuilt(built);
      }
    });
  }
});

describe("VC2A named assertions", () => {
  test("ENC-ASSET-001: opset17 manifest + matching digests load as mode A", () => {
    const fx = fixture("ENC-ASSET-001");
    assert.equal(fx.expected.ok, true);
    const built = buildDir("valid");
    try {
      const load = createEncoderRuntime().load(built.dir);
      assert.equal(load.ok, true);
      if (load.ok) assert.equal(load.mode, "A");
    } finally {
      rmBuilt(built);
    }
  });
  test("ENC-DIGEST-002: one-byte model mutation demotes before load", () => {
    const fx = fixture("ENC-DIGEST-002");
    assert.equal(fx.expected.code, ENC_FAIL.DIGEST_MISMATCH);
    const built = buildDir("mutate-onnx");
    try {
      const res = verifyEncoderAsset(built.dir, readEncoderManifest(built.dir));
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.DIGEST_MISMATCH);
    } finally {
      rmBuilt(built);
    }
  });
  test("ENC-PLATFORM-003: unsupported architecture selects trigram B", () => {
    const fx = fixture("ENC-PLATFORM-003");
    assert.equal(fx.expected.mode, "B");
    const built = buildDir("valid");
    try {
      const load = createEncoderRuntime({ platform: () => null }).load(built.dir);
      assert.equal(load.ok, false);
      if (!load.ok) {
        assert.equal(load.mode, "B", "trigram B selected");
        assert.equal(load.code, ENC_FAIL.PLATFORM_UNSUPPORTED);
      }
    } finally {
      rmBuilt(built);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — invariant + unique failure injection + forced triad
// ---------------------------------------------------------------------------
describe("encoder runtime invariant + injection + triad", () => {
  test("invariant: only batch1/max512 verified assets reach inference", () => {
    const built = buildDir("valid");
    try {
      const rt = createEncoderRuntime();
      const load = rt.load(built.dir);
      assert.equal(load.ok, true);
      if (load.ok) assert.equal(load.mode, "A");
      // dims 1..512 infer; 0 and 513+ are shape-rejected.
      for (const n of [1, 64, 512]) {
        const inf = rt.infer({ tokens: Array.from({ length: n }, (_, i) => i % 500) });
        assert.equal(inf.ok, true, `dim ${n} infers`);
      }
      for (const n of [0, 513, 1000]) {
        const inf = rt.infer({ tokens: Array.from({ length: n }) });
        assert.equal(inf.ok, false, `dim ${n} shape-rejected`);
        if (!inf.ok) assert.equal(inf.code, ENC_FAIL.SHAPE_INVALID);
      }
      // A batch>1 manifest never reaches inference: verification demotes to B.
      const bad = buildDir("batch-2");
      try {
        const checker = createEncoderRuntime();
        const check = checker.load(bad.dir);
        assert.equal(check.ok, false);
        if (!check.ok) assert.equal(check.code, ENC_FAIL.BATCH_INVALID);
      } finally {
        rmBuilt(bad);
      }
    } finally {
      rmBuilt(built);
    }
  });
  test("1..513 maxTokens manifests: 1..512 verify+infer, 513 demotes TOKENS_EXCEEDED", () => {
    for (const maxTok of [1, 64, 512]) {
      const dir = tmpAsset("vc2a-dim");
      mkdirSync(dir, { recursive: true });
      const onnx = Buffer.from(`dim-${maxTok}`, "binary");
      const tok = Buffer.from('{"vocab":[]}', "utf8");
      writeFileSync(join(dir, "model.onnx"), onnx);
      writeFileSync(join(dir, "tokenizer.json"), tok);
      const m = baseManifest({
        maxTokens: maxTok,
        onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
        tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
      });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      assert.equal(verifyEncoderAsset(dir, readEncoderManifest(dir)).ok, true, `maxTokens ${maxTok} verifies`);
      const rt = createEncoderRuntime();
      assert.equal(rt.load(dir).ok, true, `maxTokens ${maxTok} loads`);
      const inf = rt.infer({ tokens: Array.from({ length: maxTok }) });
      assert.equal(inf.ok, true, `cap ${maxTok} infers`);
      rmSync(dir, { recursive: true, force: true });
    }
    // 513 demotes.
    const dir513 = tmpAsset("vc2a-dim-513");
    mkdirSync(dir513, { recursive: true });
    const onnx513 = Buffer.from("dim-513", "binary");
    const tok513 = Buffer.from('{"vocab":[]}', "utf8");
    writeFileSync(join(dir513, "model.onnx"), onnx513);
    writeFileSync(join(dir513, "tokenizer.json"), tok513);
    const m513 = baseManifest({
      maxTokens: 513,
      onnx: { path: "model.onnx", sha256: sha256(onnx513), bytes: onnx513.length },
      tokenizer: { path: "tokenizer.json", sha256: sha256(tok513), bytes: tok513.length },
    });
    writeFileSync(join(dir513, "manifest.json"), JSON.stringify(m513));
    const res = verifyEncoderAsset(dir513, readEncoderManifest(dir513));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, ENC_FAIL.TOKENS_EXCEEDED);
    rmSync(dir513, { recursive: true, force: true });
  });
  test("truncated ONNX during digest read demotes ENC_ASSET_UNREADABLE", () => {
    // Build a LIVE-platform manifest whose model.onnx is absent on disk ->
    // unreadable during the digest read -> ENC_ASSET_UNREADABLE. This is
    // platform-independent (Q02): the committed bundle is pinned to linux-x64
    // and would demote for platform reasons (PLATFORM_UNSUPPORTED) on other
    // hosts before ever reaching the digest read.
    const built = buildDir("missing-onnx");
    try {
      const load = createEncoderRuntime().load(built.dir);
      assert.equal(load.ok, false);
      if (!load.ok) {
        assert.equal(load.code, ENC_FAIL.ASSET_UNREADABLE);
        assert.equal(load.mode, "B");
      }
    } finally {
      rmBuilt(built);
    }
  });
  test("allocator failure after verification demotes ENC_ASSET_UNREADABLE", () => {
    const built = buildDir("valid");
    try {
      const load = createEncoderRuntime({ host: { allocatorFails: () => true } }).load(built.dir);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.code, ENC_FAIL.ASSET_UNREADABLE);
    } finally {
      rmBuilt(built);
    }
  });
  test("forced triad A / B / C", () => {
    // A: verified local ONNX.
    const dirA = buildDir("valid");
    try {
      assert.equal(createEncoderRuntime().load(dirA.dir).ok, true);
    } finally {
      rmBuilt(dirA);
    }
    // B: missing asset => asset-free trigram (no remote fetch) with a clear code.
    const dirB = buildDir("missing-onnx");
    try {
      const load = createEncoderRuntime().load(dirB.dir);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.mode, "B");
    } finally {
      rmBuilt(dirB);
    }
    // C: lexical forced by mode C (rollback path).
    const dirC = tmpAsset("vc2a-C");
    mkdirSync(dirC, { recursive: true });
    try {
      const load = createEncoderRuntime({ forcedMode: "C" }).load(dirC);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.mode, "C");
    } finally {
      rmSync(dirC, { recursive: true, force: true });
    }
  });
  test("acceptance budgets: infer p95 <=40ms and RSS <=150MiB", () => {
    const built = buildDir("valid");
    try {
      const rt = createEncoderRuntime();
      assert.equal(rt.load(built.dir).ok, true);
      const latencies: number[] = [];
      for (let i = 0; i < 20; i++) {
        const inf = rt.infer({ tokens: Array.from({ length: 128 }, (_, k) => k) });
        assert.equal(inf.ok, true);
        if (inf.ok) {
          latencies.push(inf.latencyMs);
          assert.ok(inf.rssBytes <= ENCODER_RSS_BUDGET_BYTES, "RSS <=150MiB");
        }
      }
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
      assert.ok(p95 <= ENCODER_LATENCY_P95_MS, `p95 ${p95} <= 40ms`);
    } finally {
      rmBuilt(built);
    }
  });
  test("all digest corruptions demote before load", () => {
    for (const which of ["onnx", "tokenizer", "both"] as const) {
      const dir = tmpAsset("vc2a-corr");
      mkdirSync(dir, { recursive: true });
      const onnx = Buffer.from("corrupt-me-onnx", "binary");
      const tok = Buffer.from('{"vocab":[]}', "utf8");
      writeFileSync(join(dir, "model.onnx"), onnx);
      writeFileSync(join(dir, "tokenizer.json"), tok);
      const m = baseManifest({
        onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
        tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
      });
      if (which === "onnx" || which === "both") writeFileSync(join(dir, "model.onnx"), Buffer.concat([onnx, Buffer.from("X")]));
      if (which === "tokenizer" || which === "both") writeFileSync(join(dir, "tokenizer.json"), Buffer.concat([tok, Buffer.from("X")]));
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      const res = verifyEncoderAsset(dir, readEncoderManifest(dir));
      assert.equal(res.ok, false, `corrupt ${which} demotes`);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.DIGEST_MISMATCH, `corrupt ${which} code`);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
