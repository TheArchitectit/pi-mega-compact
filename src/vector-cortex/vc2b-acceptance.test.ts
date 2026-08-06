/** VC2B acceptance aggregator — ENC-009..016 + named fixtures against the REAL
 *  heads/trigram/lexical producers (no mocks). Sprint: multi-head encoder.
 *
 *  Scopes: VectorSetV1/HeadCalibrationDraft registration + registration order
 *  (before training/export logic), every conformance row resolved through the
 *  real producers, the shape/norm invariant (all norms 0 or within 1e-6 of 1,
 *  repeat drift <= 1e-6), loss/seed constants, unique failure injection (delete
 *  the learned asset after A selection but before inference -> the router
 *  catches the REAL load() failure and selects independently initialized B,
 *  emitting vector_cortex_encoder_fallback_selected from the production seam),
 *  forced triad A/B/C through the encode-or-fallback router, flag-OFF parity,
 *  and the VC2B emit seam (both named events).
 *
 *  The conformance/named-assertion suites and the multi-head invariant suite
 *  live in _acceptance-vc2b-conformance.ts / _acceptance-vc2b-heads.ts; this
 *  aggregator feeds them their shared context and keeps the registration +
 *  flag-off/emit suites here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENC2B_IDS,
  ENCODER_HEAD_DIM_ORDER,
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_LOSS_WEIGHTS,
  ENCODER_HEAD_LOSS_SUM,
  ENCODER_HEAD_ORDER,
  ENCODER_MAX_TOKENS,
  ENCODER_OPSET,
  ENCODER_SEED,
} from "./encoder/types.js";
import { encodeVectorSet } from "./encoder/heads.js";
import { detectPlatform } from "./encoder/asset.js";
import { createEncoderHeadsReporter } from "./encoder/emit-vc2b.js";
import { canonicalManifestsConverge } from "./conformance/manifest.js";
import { VC2B_ENABLED } from "../config/vector-cortex.js";
import { registerConformanceRows } from "./_acceptance-vc2b-conformance.js";
import { registerHeads } from "./_acceptance-vc2b-heads.js";

// Q03 (flag-off parity): do NOT pin the flags ON at module scope. The mandated
// flag-off gate (`MEGACOMPACT_VC2B=0 node --test ...`) must genuinely exercise
// the flag-independent producer paths (shape/norm/dims/trigram/lexical) under
// the external OFF env, so that run is NOT behaviorally identical to the
// default-ON run. The ON-dependent scenarios (router A/B/C handoff, emission
// assertions) self-pin the flags ON via `withFlagsOn` and are therefore valid
// under EITHER external env, while the dedicated flag suite manages its own env.
export function withFlagsOn(fn: () => void): void {
  const keys = ["MEGACOMPACT_VC2B", "MEGACOMPACT_VC2A"] as const;
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    process.env[k] = "1";
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The temp asset's declared platform follows the LIVE detector so a staged,
 *  verifying asset directory never spuriously demotes to PLATFORM_UNSUPPORTED
 *  on a non-linux-x64 host (mirrors runtime.test.ts). */
const HOST_PLATFORM = detectPlatform() ?? "linux-x64";

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

export interface ManifestDef {
  owner: string;
  domain: string;
  fixtures: { id: string; path: string; algorithm: string }[];
}
export interface EFixture {
  id: string;
  kind: string;
  producer: string;
  input: { scenario: string; head?: string };
  expected: {
    ok: boolean;
    code?: string;
    mode?: string;
    head?: string;
    dim?: number;
    width?: number;
    heads?: number;
    dims?: number[];
    zero?: boolean;
  };
  assertion: string;
}
function readManifest(): ManifestDef {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as ManifestDef;
}
export function fixture(id: string): EFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as EFixture;
}

const ENC2B_NAMED = ["ENC-HEAD-001", "ENC-ZERO-002", "ENC-FALLBACK-003"];
const VC2B_IDS = [...ENC2B_IDS, ...ENC2B_NAMED];
export const ORDERED_DIMS = [384, 128, 128, 64, 32];

export const SET_TOKENS = [1, 2, 3, 4, 5];
export const EMPTY_TOKENS: number[] = [];

/** Stage a directory that the VC2A runtime VERIFIES into mode A: a committed
 *  manifest (live platform, opset 21, batch 1, `maxTokens` defaulting to the
 *  global 512, overridable to exercise the per-manifest token-capacity path)
 *  plus model.onnx and tokenizer.json hashed into the manifest. Returns the dir
 *  path (caller owns cleanup). */
export function stageVerifyingAssetDir(maxTokens: number = ENCODER_MAX_TOKENS): string {
  const dir = join(tmpdir(), `vc2b-asset-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const onnx = Buffer.from("staged-onnx-opset21", "binary");
  const tok = Buffer.from('{"vocab":[]}', "utf8");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  writeFileSync(join(dir, "model.onnx"), onnx);
  writeFileSync(join(dir, "tokenizer.json"), tok);
  const manifest = {
    schema: "model-manifest-v1",
    modelVersion: "acceptance",
    opset: ENCODER_OPSET,
    batch: 1,
    maxTokens,
    platform: HOST_PLATFORM,
    hiddenWidth: 384,
    semanticWidth: 384,
    heads: { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 },
    onnx: { path: "model.onnx", sha256: sha(onnx), bytes: onnx.length },
    tokenizer: { path: "tokenizer.json", sha256: sha(tok), bytes: tok.length },
    totalBytes: onnx.length + tok.length,
    trainingManifestDigest: "0".repeat(64),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

// ---------------------------------------------------------------------------
// Suite 1 — registration + canonical corpus (owner VC2B)
// ---------------------------------------------------------------------------
describe("VC2B conformance registration", () => {
  test("manifest registers every ENC-009..016 + named fixture, owner + domain list VC2B", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of VC2B_IDS) assert.ok(ids.has(id), `missing ${id}`);
    assert.ok(m.owner.includes("VC2B"), "owner lists VC2B");
    assert.ok(m.domain.includes("encoder-heads"), "domain lists encoder-heads");
    for (const id of VC2B_IDS) {
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "encoder-heads", `${id} algorithm`);
    }
  });
  test("the committed VC2B corpus is canonical (a single reproducible digest)", () => {
    assert.equal(canonicalManifestsConverge(V2), true, "committed corpus converges");
  });
  test("head order + dims are the normative 384/128/128/64/32 before training/export logic", () => {
    assert.deepEqual(
      ENCODER_HEAD_ORDER,
      ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"],
    );
    assert.deepEqual(ENCODER_HEAD_DIM_ORDER, ORDERED_DIMS);
    assert.deepEqual(
      [ENCODER_HEAD_DIMS.semantic, ENCODER_HEAD_DIMS.dependency, ENCODER_HEAD_DIMS.contradiction, ENCODER_HEAD_DIMS.cacheStability, ENCODER_HEAD_DIMS.payloadRouting],
      ORDERED_DIMS,
    );
  });
  test("losses are exactly .35/.20/.20/.15/.10 and sum to 1; seed is 1729", () => {
    const w = ENCODER_HEAD_LOSS_WEIGHTS;
    assert.equal(w.semantic, 0.35);
    assert.equal(w.dependency, 0.2);
    assert.equal(w.contradiction, 0.2);
    assert.equal(w.cacheStability, 0.15);
    assert.equal(w.payloadRouting, 0.1);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    assert.equal(Math.abs(total - ENCODER_HEAD_LOSS_SUM) < 1e-12, true);
    assert.equal(ENCODER_SEED, 1729);
  });
});

// Suites 2-4 are delegated to sibling extracts (conformance/named assertions +
// multi-head invariant/triad) — they receive their shared context inline.
registerConformanceRows({ fixture, SET_TOKENS, EMPTY_TOKENS, ORDERED_DIMS });
registerHeads({ withFlagsOn, stageVerifyingAssetDir, SET_TOKENS, EMPTY_TOKENS, ORDERED_DIMS });

// ---------------------------------------------------------------------------
// Suite 5 — flag-off parity + emit seam
// ---------------------------------------------------------------------------
describe("VC2B flag-off parity + emit", () => {
  test("flag OFF yields ZERO VC2B emissions (byte-identical predecessor)", () => {
    const emitted: string[] = [];
    const saved = process.env.MEGACOMPACT_VC2B;
    process.env.MEGACOMPACT_VC2B = "0";
    try {
      const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
      reporter.headsEmitted({ heads: 5 });
      reporter.fallbackSelected({ mode: "B" });
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2B;
      else process.env.MEGACOMPACT_VC2B = saved;
    }
    assert.deepEqual(emitted, [], "flag OFF => no emissions");
  });

  test("flag ON: producing a VectorSet and selecting a fallback emit their named events", () => {
    const saved = process.env.MEGACOMPACT_VC2B;
    process.env.MEGACOMPACT_VC2B = "1";
    const emitted: string[] = [];
    try {
      const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
      encodeVectorSet(SET_TOKENS, { reporter });
      reporter.fallbackSelected({ mode: "B", width: 512 });
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2B;
      else process.env.MEGACOMPACT_VC2B = saved;
    }
    assert.ok(emitted.includes("vector_cortex_encoder_heads_emitted"));
    assert.ok(emitted.includes("vector_cortex_encoder_fallback_selected"));
  });

  test("VC2B flag is defined, default ON, and =0 disables", () => {
    const saved = process.env.MEGACOMPACT_VC2B;
    delete process.env.MEGACOMPACT_VC2B;
    try {
      assert.equal(VC2B_ENABLED(), true, "default ON");
    } finally {
      if (saved !== undefined) process.env.MEGACOMPACT_VC2B = saved;
    }
    process.env.MEGACOMPACT_VC2B = "0";
    assert.equal(VC2B_ENABLED(), false, "=0 disables");
    process.env.MEGACOMPACT_VC2B = "1";
    assert.equal(VC2B_ENABLED(), true, "pinned ON");
  });
});
