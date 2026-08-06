/**
 * pcd-acceptance.test.ts — PC-D benchmark roll-up acceptance aggregator.
 *
 * Drives the committed PC-016..019 prompt-cache fixtures against the canonical
 * corpus — no mocks, no stubs, no runtime module import, flag-agnostic (green
 * under every flag state, since this sprint adds no new flag). Pins the
 * PC-D roll-up contract from the FIXTURE data itself:
 *   - 016: the benchmark runner's flag-state grouping methodology (pre-pc /
 *     pc-a / pc-b groups from deploy-date time cutoffs) computes providerCachePct
 *     ratios per group.
 *   - 017: --synthetic replay is deterministic with the improvement direction
 *     separated > unseparated and striped >= separated.
 *   - 018: the evidence record measures all three flag states and the
 *     prior PC-A/PC-B/PC-C evidence records are accepted.
 *   - 019: the reserved range PC-001..019 is fully documented, all 19 fixtures
 *     registered, and the multi-sprint PC roll-up is complete.
 *
 * The concrete grouping + aggregate math is exercised black-box by
 * scripts/pc-prompt-cache/bench-hit-rate.mjs (run standalone against a seeded
 * perf_samples store); this aggregator pins the FIXTURE INTEGRITY + the
 * semantic matrix, exactly as the pca/pcb/pcc siblings do.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  schema: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}

/** The canonical PC-D prompt-cache fixture ids this sprint owns. */
const PC_IDS = ["PC-016", "PC-017", "PC-018", "PC-019"] as const;

const GROUPS = ["pre-pc", "pc-a", "pc-b"] as const;
const PRIOR_EVIDENCE = ["PC-A", "PC-B", "PC-C"] as const;
/** Full documented reserved range across the four PC sprints. */
const RESERVED_RANGE = Array.from({ length: 19 }, (_, i) => `PC-${String(i + 1).padStart(3, "0")}`);

interface PromptCacheFixture {
  id: string;
  kind: string;
  benchmark?: string;
  groups?: string[];
  ratios_computed?: boolean;
  ratio_formula?: string;
  grouping_source?: string;
  deterministic?: boolean;
  improvement_direction?: string;
  striped_direction?: string;
  llm?: boolean;
  network?: boolean;
  evidence?: string;
  flag_states_measured?: number;
  all_prior_evidence_accepted?: boolean;
  prior_evidence?: string[];
  reserved_range?: string;
  manifest_entries?: number;
  roll_up?: boolean;
  owner_groups?: Record<string, string[]>;
}

function readFixture(id: string): PromptCacheFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("prompt-cache/"));
  assert.ok(row, `fixture ${id} registered under prompt-cache/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as PromptCacheFixture;
}

describe("PC-D conformance registration", () => {
  test("manifest registers PC-016..019 under the prompt-cache seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of PC_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of PC_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "prompt-cache", `${id} algorithm`);
      assert.equal(
        row!.schema,
        "schemas/prompt-cache-fixture.schema.json",
        `${id} schema ref`,
      );
    }
  });

  test("reserved range PC-001..019 is fully registered in the manifest", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of RESERVED_RANGE) {
      assert.ok(ids.has(id), `reserved fixture ${id} missing`);
    }
    const pcRows = m.fixtures.filter((f) => f.path.startsWith("prompt-cache/"));
    assert.equal(
      pcRows.length,
      RESERVED_RANGE.length,
      "the prompt-cache seam carries exactly the 19 reserved fixtures",
    );
  });
});

describe("PC-016..019 prompt-cache envelopes", () => {
  test("all 4 fixtures satisfy the envelope invariants", () => {
    for (const id of PC_IDS) {
      const fx = readFixture(id);
      assert.equal(fx.kind, "prompt-cache", `${id}: kind`);
    }
  });

  test("016 pins the benchmark flag-state grouping methodology", () => {
    const fx = readFixture("PC-016");
    assert.equal(fx.benchmark, "flag-state-grouping");
    assert.deepEqual(fx.groups, [...GROUPS]);
    assert.equal(fx.ratios_computed, true);
    assert.match(fx.ratio_formula ?? "", /cacheRead\/\(cacheRead\+input\+cacheWrite\)\*100/);
    assert.equal(typeof fx.grouping_source, "string");
    assert.ok((fx.grouping_source ?? "").length > 0);
    assert.match(fx.grouping_source ?? "", /cutoff/i);
  });

  test("017 pins synthetic replay determinism + improvement direction", () => {
    const fx = readFixture("PC-017");
    assert.equal(fx.benchmark, "synthetic-replay");
    assert.equal(fx.deterministic, true);
    assert.equal(fx.improvement_direction, "separated>unseparated");
    assert.equal(fx.striped_direction, "striped>=separated");
    assert.equal(fx.llm, false, "no live LLM in synthetic replay");
    assert.equal(fx.network, false, "no network (PREVENT-PI-004)");
  });

  test("018 pins evidence completeness for all three flag states", () => {
    const fx = readFixture("PC-018");
    assert.equal(fx.evidence, "PC-D");
    assert.equal(fx.flag_states_measured, 3);
    assert.equal(fx.all_prior_evidence_accepted, true);
    assert.deepEqual(fx.prior_evidence, [...PRIOR_EVIDENCE]);
  });

  test("019 pins the conformance roll-up: reserved range + all 19 registered", () => {
    const fx = readFixture("PC-019");
    assert.equal(fx.reserved_range, "PC-001..019");
    assert.equal(fx.manifest_entries, RESERVED_RANGE.length);
    assert.equal(fx.roll_up, true);
    // The owner_groups spans are inclusive [low, high] ranges that must exactly
    // tile the reserved range with no gaps and no overlaps.
    const og = fx.owner_groups ?? {};
    const spanOf = (endpoint: string): number =>
      Number.parseInt(endpoint.replace("PC-", ""), 10);
    const ids = new Set<string>();
    for (const [owner, list] of Object.entries(og)) {
      assert.ok(
        ["PC-A", "PC-B", "PC-C", "PC-D"].includes(owner),
        `unknown owner ${owner}`,
      );
      assert.ok(Array.isArray(list) && list.length === 2, `${owner} owns a 2-endpoint span`);
      const [lo, hi] = [spanOf(list[0]), spanOf(list[1])];
      assert.ok(lo >= 1 && hi <= 19, `${owner} span within reserved range`);
      assert.ok(lo <= hi, `${owner} span is low-to-high`);
      for (let n = lo; n <= hi; n++) {
        const id = `PC-${String(n).padStart(3, "0")}`;
        const prev = ids.has(id);
        assert.equal(prev, false, `owner span overlap at ${id}`);
        ids.add(id);
      }
    }
    for (const id of RESERVED_RANGE) {
      assert.ok(ids.has(id), `owner partition missing ${id}`);
    }
  });
});
