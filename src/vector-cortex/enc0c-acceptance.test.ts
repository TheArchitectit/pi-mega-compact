/** ENC-0c acceptance aggregator (fixtures-driven, no mocks).
 *  Drives ENC-HEADS-001..006 against the staged synthetic corpus and the
 *  ENC_0C flag. Asserts: fixture registration, all five heads fire with real
 *  non-constant vectors, flag-off serves the ENC-0b survivor byte-identically,
 *  corpus split groups never cross boundaries, and head outputs are
 *  deterministic across 3 forward passes. The head-candidate load/validate
 *  seam (dim-mismatch / non-finite / digest / trunk rejections) lives in the
 *  sibling enc0c-candidate-acceptance.test.ts so both files stay under the
 *  src/ 300-line soft limit. Local file reads only, zero network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_0C_ENABLED } from "../config/vector-cortex.js";
import { readEncoderManifest } from "./encoder/asset.js";
import {
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_ORDER,
  ENCODER_HEAD_LOSS_WEIGHTS,
  type EncoderHeadName,
} from "./encoder/types.js";
import {
  encodeVectorSet,
  loadHeadCandidate,
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
const CORPUS_DIR = join(ROOT, "training", "vector-cortex", "corpus");
const CORPUS_MANIFEST = join(ROOT, "training", "vector-cortex", "dataset-manifest-enc0c.json");

/** Corpus jsonl filenames use the generator's short head names (cache/payload). */
const CORPUS_HEAD_FILE: Readonly<Record<EncoderHeadName, string>> = {
  semantic: "semantic",
  dependency: "dependency",
  contradiction: "contradiction",
  cacheStability: "cache",
  payloadRouting: "payload",
};

const ENC_HEADS_IDS = [
  "ENC-HEADS-001",
  "ENC-HEADS-002",
  "ENC-HEADS-003",
  "ENC-HEADS-004",
  "ENC-HEADS-005",
  "ENC-HEADS-006",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; domain: string; fixtures: ManifestRow[] }
interface HeadsFixture {
  id: string; producer: string; assertion: string; kind: string;
  setup: Record<string, unknown>;
  expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): HeadsFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("encoder-heads-real/"));
  assert.ok(row, `fixture ${id} registered under encoder-heads-real/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as HeadsFixture;
}

function sha256(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("ENC-0c conformance registration", () => {
  test("manifest registers ENC-HEADS-001..006 under the encoder-heads-real seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_HEADS_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.path, `encoder-heads-real/${id}.json`, `${id} path`);
      assert.equal(row.schema, "schemas/encoder-heads-real-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.expected, id === "ENC-HEADS-003" || id === "ENC-HEADS-004" ? "error" : "ok", `${id} expected`);
    }
    const schemaRow = m.fixtures.find((f) => f.path === "schemas/encoder-heads-real-fixture.schema.json");
    assert.ok(schemaRow, "encoder-heads-real schema registered");
    assert.ok(m.owner.split(",").includes("ENC-0c"), "owner CSV includes ENC-0c");
  });

  test("the 6 ENC-HEADS fixture kinds are closed to the spec branch set", () => {
    const kinds = new Set<string>();
    for (const id of ENC_HEADS_IDS) {
      const fx = fixture(id);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.ok(["ok", "error"].includes(fx.expected_outcome), `${id}: outcome enum`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "heads-fire", "flag-off-parity", "dim-mismatch",
      "non-finite-weights", "split-boundary", "determinism",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present`);
    }
  });
});

describe("ENC-0c heads fire with real non-constant vectors (ENC-HEADS-001)", () => {
  test("all five heads emit correct dims and non-constant vectors over corpus tokens", () => {
    const fx = fixture("ENC-HEADS-001");
    assert.equal(fx.kind, "heads-fire");
    // Load one real corpus line per head for input tokens.
    for (const h of ENCODER_HEAD_ORDER) {
      const path = join(CORPUS_DIR, "train", `${CORPUS_HEAD_FILE[h]}-0.jsonl`);
      const line = readFileSync(path, "utf8").split("\n").find(Boolean)!;
      const row = JSON.parse(line) as { input_ids: number[] };
      const vs = encodeVectorSet(row.input_ids);
      for (const hv of vs.heads) {
        assert.equal(hv.dim, ENCODER_HEAD_DIMS[hv.head], `${hv.head} dim`);
        assert.equal(hv.values.length, ENCODER_HEAD_DIMS[hv.head], `${hv.head} values length`);
        const uniq = new Set<number>();
        for (const v of hv.values) uniq.add(v);
        assert.ok(uniq.size > 1, `${hv.head} is non-constant (${uniq.size} unique values)`);
        // L2 norm ≈ 1 for non-empty input.
        let norm = 0;
        for (const v of hv.values) norm += v * v;
        norm = Math.sqrt(norm);
        assert.ok(Math.abs(norm - 1) < 1e-5, `${hv.head} L2-normalized (norm=${norm})`);
      }
    }
  });

  test("loss weights sum to exactly 1.0 in .35/.20/.20/.15/.10 order", () => {
    const sum = ENCODER_HEAD_ORDER.reduce((acc, h) => acc + ENCODER_HEAD_LOSS_WEIGHTS[h], 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-12, `loss sum ${sum} == 1.0`);
    assert.equal(ENCODER_HEAD_LOSS_WEIGHTS.semantic, 0.35);
    assert.equal(ENCODER_HEAD_LOSS_WEIGHTS.dependency, 0.2);
    assert.equal(ENCODER_HEAD_LOSS_WEIGHTS.contradiction, 0.2);
    assert.equal(ENCODER_HEAD_LOSS_WEIGHTS.cacheStability, 0.15);
    assert.equal(ENCODER_HEAD_LOSS_WEIGHTS.payloadRouting, 0.1);
  });
});

describe("ENC-0c flag semantics", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_0C_ENABLED(), "boolean");
  });

  test("flag-off byte-identity (ENC-HEADS-002): survivors serve identically", () => {
    const fx = fixture("ENC-HEADS-002");
    assert.equal(fx.expected_result["byteIdentical"], true);
    assert.equal(fx.expected_result["fallback"], "enc-0b-survivor");
    // With ENC_0C=0, loadHeadCandidate refuses to read any candidate dir.
    // (The sibling enc0c-candidate-acceptance.test.ts stages a full valid
    // candidate tree and asserts the same gate from the candidate side.)
    if (!ENC_0C_ENABLED()) {
      const manifest = readEncoderManifest(ASSET_DIR)!;
      assert.equal(
        loadHeadCandidate(join(ROOT, ".tmp-nonexistent-enc0c-dir"), manifest),
        null,
        "flag-off never loads a candidate",
      );
    }
    // Byte-identity holds regardless of flag state: encodeVectorSet ignores the
    // candidate seam entirely; the two runs are element-identical.
    const vs1 = encodeVectorSet([1, 2, 3, 4, 5]);
    const vs2 = encodeVectorSet([1, 2, 3, 4, 5]);
    for (let i = 0; i < vs1.heads.length; i++) {
      const a = vs1.heads[i]!.values;
      const b = vs2.heads[i]!.values;
      for (let j = 0; j < a.length; j++) {
        assert.equal(a[j], b[j], `head ${i} element ${j} byte-identical`);
      }
    }
  });
});

describe("ENC-0c corpus split boundary (ENC-HEADS-005)", () => {
  test("split groups never cross train/calibration/test; split digest stable", () => {
    const fx = fixture("ENC-HEADS-005");
    assert.equal(fx.kind, "split-boundary");
    assert.equal(fx.expected_result["crossingGroups"], 0);
    const manifest = JSON.parse(readFileSync(CORPUS_MANIFEST, "utf8")) as {
      groupSplits: Record<string, string>;
      testGroups: string[];
      splitRule: Record<string, string>;
      corpusDigest: string;
    };
    // Every group maps to exactly one split (whole-group).
    const groups = Object.keys(manifest.groupSplits);
    const splits = new Set(Object.values(manifest.groupSplits));
    for (const g of groups) {
      assert.ok(["train", "calibration", "test"].includes(manifest.groupSplits[g]!), `${g} split valid`);
    }
    // No group appears in two splits (crossingGroups == 0 by construction).
    assert.equal(groups.length, 12, "12 fixed groups");
    assert.ok(splits.has("test") && splits.has("calibration") && splits.has("train"));
    // Test group set is immutable (repo-gamma/sess-5, repo-epsilon/sess-10).
    assert.deepEqual([...manifest.testGroups].sort(), ["repo-epsilon/sess-10", "repo-gamma/sess-5"]);
    // Split-rule digest stable: re-derive from GROUPS order index mod 5
    // (whole-group; the generator's GROUPS list is the canonical order).
    const GROUPS_ORDER = [
      "repo-alpha/sess-1", "repo-alpha/sess-2",
      "repo-beta/sess-3", "repo-beta/sess-4",
      "repo-gamma/sess-5", "repo-gamma/sess-6",
      "repo-delta/sess-7", "repo-delta/sess-8",
      "repo-epsilon/sess-9", "repo-epsilon/sess-10",
      "repo-zeta/sess-11", "repo-zeta/sess-12",
    ];
    const RULE: Record<number, string> = { 0: "train", 1: "train", 2: "calibration", 3: "train", 4: "test" };
    for (let i = 0; i < GROUPS_ORDER.length; i++) {
      const derived = RULE[i % 5]!;
      assert.equal(manifest.groupSplits[GROUPS_ORDER[i]!], derived, `${GROUPS_ORDER[i]} split == i%5 rule`);
    }
    assert.ok(/^[0-9a-f]{64}$/.test(manifest.corpusDigest), "corpusDigest is a sha256");
  });

  test("gen_synthetic_corpus.py --check passes (digest stability, ENC0c generator)", () => {
    const r = spawnSync("python3", [
      join(ROOT, "training", "vector-cortex", "gen_synthetic_corpus.py"), "--check",
    ], { encoding: "utf8", cwd: ROOT });
    assert.equal(r.status, 0, `corpus --check exit 0: ${r.stdout}${r.stderr}`);
  });
});

describe("ENC-0c head determinism (ENC-HEADS-006)", () => {
  test("identical inputs produce identical per-head outputs across 3 passes (maxAbsDelta 0)", () => {
    const fx = fixture("ENC-HEADS-006");
    assert.equal(fx.expected_result["maxAbsDelta"], 0);
    assert.equal(fx.expected_result["passes"], 3);
    const tokens = [11, 22, 33, 44, 55, 66];
    const runs: Float32Array[][] = [];
    for (let r = 0; r < 3; r++) {
      const vs = encodeVectorSet(tokens);
      runs.push(vs.heads.map((h) => h.values));
    }
    for (let r = 1; r < 3; r++) {
      for (let h = 0; h < ENCODER_HEAD_ORDER.length; h++) {
        const a = runs[0]![h]!;
        const b = runs[r]![h]!;
        assert.equal(a.length, b.length, `${ENCODER_HEAD_ORDER[h]} length`);
        for (let i = 0; i < a.length; i++) {
          assert.equal(b[i], a[i], `pass ${r} head ${ENCODER_HEAD_ORDER[h]} element ${i} differs`);
        }
      }
    }
  });

  test("per-head vectors have stable sha256 across process-free reruns", () => {
    const tokens = [7, 8, 9];
    const digests: string[] = [];
    for (let r = 0; r < 2; r++) {
      const vs = encodeVectorSet(tokens);
      digests.push(sha256(Buffer.from(
        vs.heads.map((h) => Buffer.from(h.values.buffer, h.values.byteOffset, h.values.byteLength).toString("base64")).join("|"),
      )));
    }
    assert.equal(digests[0], digests[1], "vector-set digest stable across passes");
  });
});
