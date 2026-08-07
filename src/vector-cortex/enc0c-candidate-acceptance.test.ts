/** ENC-0c candidate-load acceptance sibling (fixtures-driven, no mocks).
 *  Split from enc0c-acceptance.test.ts so both files stay under the src/
 *  300-line soft limit (soft-as-hard gate). Owns the head-candidate seam:
 *  staging a head-candidate-v1 tree in a temp dir, asserting well-formed
 *  candidates load+validate, and asserting each failure mode (missing head,
 *  non-finite weights, corrupt digest, trunk-digest mismatch) is rejected
 *  without a partial load. Flag-gate test runs in both MEGACOMPACT_ENC_0C
 *  states (ON loads, OFF refuses). Local temp dirs only, zero network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_0C_ENABLED } from "../config/vector-cortex.js";
import { readEncoderManifest } from "./encoder/asset.js";
import {
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_ORDER,
  type EncoderHeadName,
} from "./encoder/types.js";
import {
  loadHeadCandidate,
  validateHeadCandidate,
  HEAD_CANDIDATE_SCHEMA,
  HEAD_CANDIDATE_FAIL,
  type HeadCandidateManifest,
} from "./encoder/heads.js";

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
const ASSET_DIR = join(ROOT, "assets", "vector-cortex", "encoder-v1");

interface HeadsFixture {
  id: string; kind: string; expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}
function fixture(id: string): HeadsFixture {
  const m = JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as {
    fixtures: { id: string; path: string }[];
  };
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("encoder-heads-real/"));
  assert.ok(row, `fixture ${id} registered under encoder-heads-real/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as HeadsFixture;
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build a minimal head-candidate-v1 dir (deterministic non-constant weights). */
function stageCandidate(dir: string, overrides?: {
  omitHead?: EncoderHeadName;
  nonFiniteHead?: EncoderHeadName;
  digestCorrupt?: boolean;
  trunkDigestOverride?: string;
}): void {
  const manifest = readEncoderManifest(ASSET_DIR)!;
  const heads = [];
  let totalBytes = 0;
  for (const h of ENCODER_HEAD_ORDER) {
    const dim = ENCODER_HEAD_DIMS[h];
    const w = new Float32Array(dim);
    for (let i = 0; i < dim; i++) w[i] = Math.sin((i + 1) * 0.001 * (ENCODER_HEAD_ORDER.indexOf(h) + 1));
    let norm = 0;
    for (const v of w) norm += v * v;
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) w[i] = w[i]! / norm;
    if (overrides?.nonFiniteHead === h) w[0] = Number.NaN;
    const bytes = Buffer.from(w.buffer, w.byteOffset, dim * 4);
    let digest = sha256(bytes);
    if (overrides?.digestCorrupt && h === "contradiction") digest = "0".repeat(64);
    writeFileSync(join(dir, `${h}.bin`), bytes);
    heads.push({ name: h, dim, sha256: digest, bytes: dim * 4 });
    totalBytes += dim * 4;
  }
  const effective = overrides?.omitHead
    ? heads.filter((x) => x.name !== overrides.omitHead)
    : heads;
  const manifestObj: HeadCandidateManifest = {
    schema: HEAD_CANDIDATE_SCHEMA,
    version: "encoder-v1",
    trunkDigest: overrides?.trunkDigestOverride ?? manifest.onnx.sha256,
    heads: effective,
    totalBytes: overrides?.omitHead ? totalBytes - ENCODER_HEAD_DIMS[overrides.omitHead] * 4 : totalBytes,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestObj));
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "enc0c-cand-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ENC-0c candidate load seam", () => {
  test("a well-formed staged candidate loads and validates (HEAD_CANDIDATE_SCHEMA)", () => {
    if (!ENC_0C_ENABLED()) return; // flag-off state covered by the flag-gate test below.
    withTempDir((dir) => {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      stageCandidate(dir);
      const loaded = loadHeadCandidate(dir, manifest);
      assert.ok(loaded, "candidate loads");
      assert.equal(loaded!.schema, HEAD_CANDIDATE_SCHEMA);
      for (const h of ENCODER_HEAD_ORDER) {
        assert.equal(loaded!.dims[h], ENCODER_HEAD_DIMS[h], `${h} dim`);
        assert.equal(loaded!.weights[h].length, ENCODER_HEAD_DIMS[h], `${h} weights length`);
      }
      assert.ok(validateHeadCandidate(loaded!).ok, "candidate validates");
    });
  });

  test("a missing head is rejected with no partial load (ENC-HEADS-003)", () => {
    if (!ENC_0C_ENABLED()) return;
    const fx = fixture("ENC-HEADS-003");
    assert.equal(fx.expected_result["rejected"], "dim-mismatch");
    assert.equal(fx.expected_result["partialLoad"], false);
    withTempDir((dir) => {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      stageCandidate(dir, { omitHead: "payloadRouting" });
      assert.equal(loadHeadCandidate(dir, manifest), null, "missing head rejected, no partial load");
    });
  });

  test("non-finite or digest-corrupt candidate rejected, never force-loaded (ENC-HEADS-004)", () => {
    if (!ENC_0C_ENABLED()) return;
    const fx = fixture("ENC-HEADS-004");
    assert.equal(fx.expected_result["rejected"], "non-finite-weights");
    assert.equal(fx.expected_result["forceLoad"], false);
    withTempDir((dir) => {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      stageCandidate(dir, { nonFiniteHead: "contradiction" });
      assert.equal(loadHeadCandidate(dir, manifest), null, "NaN candidate rejected");
    });
    withTempDir((dir) => {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      stageCandidate(dir, { digestCorrupt: true });
      assert.equal(loadHeadCandidate(dir, manifest), null, "digest-corrupt candidate rejected");
    });
  });

  test("trunk-digest mismatch rejects the candidate (frozen-trunk pinning)", () => {
    if (!ENC_0C_ENABLED()) return;
    withTempDir((dir) => {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      stageCandidate(dir, { trunkDigestOverride: "f".repeat(64) });
      assert.equal(loadHeadCandidate(dir, manifest), null, "wrong trunkDigest rejected");
    });
  });

  test("HEAD_CANDIDATE_FAIL codes cover the spec rejection surface", () => {
    for (const k of ["INVALID", "TRUNK_MISMATCH", "DIM_MISMATCH", "NON_FINITE", "DIGEST_MISMATCH"]) {
      assert.ok((HEAD_CANDIDATE_FAIL as Record<string, string>)[k], `HEAD_CANDIDATE_FAIL.${k}`);
    }
  });
});

describe("ENC-0c candidate flag gate (ENC-HEADS-002)", () => {
  test("flag OFF refuses the load; flag ON loads the staged candidate", () => {
    withTempDir((dir) => {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      stageCandidate(dir);
      const loaded = loadHeadCandidate(dir, manifest);
      if (ENC_0C_ENABLED()) {
        assert.ok(loaded, "flag ON: candidate loads");
      } else {
        assert.equal(loaded, null, "flag OFF: never loads a candidate (byte-identical survivor)");
      }
    });
  });
});
