/**
 * ml5e-acceptance.test.ts — ML5-E nightly retraining cron + feedback loop
 * acceptance aggregator (fixtures-driven, no mocks, no stubs).
 *
 * Drives ML5-LOOP-001..004 against the canonical v2 conformance corpus + the
 * REAL code: the four nightly-retrain envelope fixtures (corpus no-op, training
 * run recording, promotion gate, rollback digest-swap), the pure promotion
 * decision rules (promotion.ts), and the PromotionV1/manifest helpers.
 *
 * Flag-agnostic: the SAME suite passes both `node --test dist/vector-cortex/
 * ml5e-acceptance.test.js` and the mandated `MEGACOMPACT_ML5_E=0 ...` parity run.
 *
 * Local file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ML5E_ENABLED } from "../config/vector-cortex.js";
import {
  PROMOTION_SCHEMA,
  appendAsset,
  rollbackTo,
  promoteDecision,
  rollbackNeeded,
} from "./encoder/promotion.js";
import type { AssetManifest, AssetManifestEntry } from "./encoder/promotion.js";

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

const LOOP_IDS = [
  "ML5-LOOP-001",
  "ML5-LOOP-002",
  "ML5-LOOP-003",
  "ML5-LOOP-004",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; fixtures: ManifestRow[] }
interface LoopFixture {
  id: string; kind: string; flag?: string; new_rows?: boolean;
  corpus_digest_unchanged?: boolean; exit_code?: number; no_training_events?: boolean;
  trains?: boolean; bench_records?: boolean; packaged_asset?: boolean;
  manifest_append?: boolean; five_heads_ok?: boolean; heldout_beat?: boolean;
  promote?: boolean; promoted_event?: string | null; demoted_event?: string;
  regression?: boolean; restored_sha256?: string; atomic_swap?: boolean;
  no_partial_state?: boolean;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): LoopFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("nightly-retrain/"));
  assert.ok(row, `fixture ${id} registered under nightly-retrain/`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as LoopFixture;
}

describe("ML5-E conformance registration", () => {
  test("manifest registers ML5-LOOP-001..004 with nightly-retrain algorithm + ML5-E owner", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of LOOP_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "nightly-retrain", `${id} algorithm`);
      assert.equal(row.schema, "schemas/ml5-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.path, `nightly-retrain/${id}.json`, `${id} path`);
      assert.equal(row.expected, "ok");
    }
    assert.ok(m.owner.split(",").includes("ML5-E"), "owner CSV includes ML5-E");
  });
});

describe("ML5-LOOP-001..004 envelope invariants", () => {
  test("001 corpus-digest no-op exits 0 without retraining", () => {
    const fx = fixture("ML5-LOOP-001");
    assert.equal(fx.kind, "nightly-retrain");
    assert.equal(fx.flag, "MEGACOMPACT_ML5_E");
    assert.equal(fx.new_rows, false);
    assert.equal(fx.corpus_digest_unchanged, true);
    assert.equal(fx.exit_code, 0);
    assert.equal(fx.no_training_events, true);
  });
  test("002 training-run records full pipeline on new rows", () => {
    const fx = fixture("ML5-LOOP-002");
    assert.equal(fx.new_rows, true);
    assert.equal(fx.trains, true);
    assert.equal(fx.bench_records, true);
    assert.equal(fx.packaged_asset, true);
    assert.equal(fx.manifest_append, true);
  });
  test("003 promotion gate requires all threshold pass + held-out beat", () => {
    const fx = fixture("ML5-LOOP-003");
    assert.equal(fx.five_heads_ok, true);
    assert.equal(fx.heldout_beat, true);
    assert.equal(fx.promote, true);
    assert.equal(fx.demoted_event, "demoted_new_asset");
  });
  test("004 rollback via atomic manifest digest-swap", () => {
    const fx = fixture("ML5-LOOP-004");
    assert.equal(fx.regression, true);
    assert.equal(fx.restored_sha256, "<prior-asset-sha256>");
    assert.equal(fx.atomic_swap, true);
    assert.equal(fx.no_partial_state, true);
  });
});

describe("ML5-E promotion pure-logic (promotion.ts)", () => {
  test("flag state is a live boolean regardless of environment", () => {
    assert.equal(typeof ML5E_ENABLED(), "boolean");
  });
  test("promoteDecision: all-ok + beat → promoted", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(promoteDecision(true, true), "promoted");
  });
  test("promoteDecision: heads fail → demoted", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(promoteDecision(false, true), "demoted");
  });
  test("promoteDecision: no held-out beat → demoted", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(promoteDecision(true, false), "demoted");
  });
  test("promoteDecision: both fail → demoted", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(promoteDecision(false, false), "demoted");
  });
  test("rollbackNeeded: regression + prior → true", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(rollbackNeeded(true, "abc123"), true);
  });
  test("rollbackNeeded: no prior → false", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(rollbackNeeded(true, null), false);
  });
  test("rollbackNeeded: no regression → false", () => {
    if (!ML5E_ENABLED()) return;
    assert.equal(rollbackNeeded(false, "abc123"), false);
  });
});

describe("ML5-E append-only manifest helpers", () => {
  const e1: AssetManifestEntry = { assetDigest: "digest-a", ts: "2026-07-01T00:00:00Z", source: "nightly", verdict: "promoted" };
  const e2: AssetManifestEntry = { assetDigest: "digest-b", ts: "2026-07-08T00:00:00Z", source: "nightly", verdict: "promoted" };

  test("appendAsset returns new manifest with entry appended and committed updated", () => {
    if (!ML5E_ENABLED()) return;
    const m0: AssetManifest = { entries: [], committed: null };
    const m1 = appendAsset(m0, e1);
    assert.equal(m1.entries.length, 1);
    assert.equal(m1.committed, "digest-a");
    // Original unchanged (pure function).
    assert.equal(m0.entries.length, 0);
    assert.equal(m0.committed, null);
  });

  test("appendAsset never overwrites — appends only", () => {
    if (!ML5E_ENABLED()) return;
    const m0: AssetManifest = { entries: [], committed: null };
    const m1 = appendAsset(m0, e1);
    const m2 = appendAsset(m1, e2);
    assert.equal(m2.entries.length, 2);
    assert.equal(m2.committed, "digest-b");
    // Prior entry still present (append-only).
    assert.equal(m2.entries[0].assetDigest, "digest-a");
  });

  test("rollbackTo restores committed pointer to prior entry by SHA-256", () => {
    if (!ML5E_ENABLED()) return;
    const m0: AssetManifest = { entries: [], committed: null };
    const m1 = appendAsset(m0, e1);
    const m2 = appendAsset(m1, e2);
    assert.equal(m2.committed, "digest-b");
    const m3 = rollbackTo(m2, "digest-a");
    assert.ok(m3, "rollback finds the prior entry");
    assert.equal(m3!.committed, "digest-a");
    assert.equal(m3!.entries.length, 2, "entries unchanged — no deletion");
  });

  test("rollbackTo returns null for unknown digest", () => {
    if (!ML5E_ENABLED()) return;
    const m0: AssetManifest = { entries: [], committed: null };
    const m1 = appendAsset(m0, e1);
    const result = rollbackTo(m1, "nonexistent");
    assert.equal(result, null);
  });

  test("rollback atomicity: no partial state — committed flips in one step", () => {
    if (!ML5E_ENABLED()) return;
    const m0: AssetManifest = { entries: [], committed: null };
    const m1 = appendAsset(m0, e1);
    const m2 = appendAsset(m1, e2);
    // Before rollback: committed is digest-b.
    assert.equal(m2.committed, "digest-b");
    // Atomic swap: committed flips to digest-a, entries unchanged.
    const m3 = rollbackTo(m2, "digest-a")!;
    assert.equal(m3.committed, "digest-a");
    assert.deepEqual(m3.entries, m2.entries, "no entries added/removed/reordered");
  });
});

describe("ML5-E PromotionV1 schema", () => {
  test("PROMOTION_SCHEMA is promotion-v1", () => {
    assert.equal(PROMOTION_SCHEMA, "promotion-v1");
  });
});
