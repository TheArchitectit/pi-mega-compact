// VC3B topology fixtures
// (`conformance/vector-cortex/v2/topology/`).
//
// Owner VC3B (TopologyV1 / EdgeV1, deterministic cortical topology). Each
// fixture declares a build condition the acceptance test executes against the
// REAL deterministic topology builder (src/vector-cortex/topology/build.js), no
// mocks. `input.scenario` names the condition; `expected.ok` pins the successful
// behavior or the exact failure `code`.
//
// TOP-001..020 are the registered VC3B conformance rows; the three NAMED rows
// (TOP-K-001 / TOP-TIE-002 / TOP-KIND-003) pin the sprint's headline assertions
// (seventeenth eligible neighbor excluded / equal scores sort target IDs by
// unsigned bytes / dependency one direction while contradiction two).

import { producer } from "./common.mjs";

const TOP_SCHEMA = "schemas/topology-fixture.schema.json";

function topoFixture(id, assertion, input, expected) {
  return { id, schema: TOP_SCHEMA, producer, assertion, kind: "topology", input, expected };
}

export const fixtures = [
  // TOP-001 — a valid dependency candidate set builds a bounded graph.
  topoFixture(
    "TOP-001",
    "a valid dependency candidate set builds a bounded topology graph",
    { scenario: "basic-build" },
    { ok: true },
  ),
  // TOP-002 — candidates at or below the calibrated threshold are excluded.
  topoFixture(
    "TOP-002",
    "candidates at or below the calibrated threshold are excluded",
    { scenario: "threshold-exclusion" },
    { ok: true },
  ),
  // TOP-003 — top-k cap: the seventeenth eligible neighbor per source/head is excluded.
  topoFixture(
    "TOP-003",
    "the seventeenth eligible neighbor per source/head is excluded (top-k=16)",
    { scenario: "cap-seventeenth" },
    { ok: true },
  ),
  // TOP-004 — stable sort precedence: score desc then unsigned target-ID bytes.
  topoFixture(
    "TOP-004",
    "equal scores sort target IDs by unsigned bytes then score desc",
    { scenario: "stable-sort" },
    { ok: true },
  ),
  // TOP-005 — self edges are removed and never emitted.
  topoFixture(
    "TOP-005",
    "self edges are removed and never emitted",
    { scenario: "self-edge-removal" },
    { ok: true },
  ),
  // TOP-006 — a non-finite score rejects its edge without poisoning other heads.
  topoFixture(
    "TOP-006",
    "a non-finite score rejects its edge as TOP_SCORE_NONFINITE",
    { scenario: "nonfinite-reject" },
    { ok: false, code: "TOP_SCORE_NONFINITE" },
  ),
  // TOP-007 — contradiction edges are emitted as symmetric paired records.
  topoFixture(
    "TOP-007",
    "contradiction edges are emitted as symmetric paired records",
    { scenario: "contradiction-pair" },
    { ok: true },
  ),
  // TOP-008 — dependency edges are emitted as single directed records.
  topoFixture(
    "TOP-008",
    "dependency edges are emitted as single directed records",
    { scenario: "dependency-directed" },
    { ok: true },
  ),
  // TOP-009 — the graph digest is independent of input ordering.
  topoFixture(
    "TOP-009",
    "the graph digest is independent of input ordering",
    { scenario: "digest-order-independent" },
    { ok: true },
  ),
  // TOP-010 — generation has no self-edge and no non-finite score.
  topoFixture(
    "TOP-010",
    "generation has no self-edge and no non-finite score",
    { scenario: "no-self-no-nan" },
    { ok: true },
  ),
  // TOP-011 — an empty candidate set yields an empty graph with a stable digest.
  topoFixture(
    "TOP-011",
    "an empty candidate set yields an empty graph with a stable digest",
    { scenario: "empty-input" },
    { ok: true },
  ),
  // TOP-012 — a single self-only candidate yields a graph with no edges.
  topoFixture(
    "TOP-012",
    "a single self-only candidate yields a graph with no edges",
    { scenario: "single-node" },
    { ok: true },
  ),
  // TOP-013 — the derived source high-water is preserved on the graph.
  topoFixture(
    "TOP-013",
    "the derived source high-water is preserved on the graph",
    { scenario: "high-water-preserve" },
    { ok: true },
  ),
  // TOP-014 — the direction enum is preserved exactly on every edge.
  topoFixture(
    "TOP-014",
    "the direction enum is preserved exactly on every edge",
    { scenario: "direction-enum" },
    { ok: true },
  ),
  // TOP-015 — duplicate contradiction pairs collapse to one symmetric pair.
  topoFixture(
    "TOP-015",
    "duplicate contradiction pairs collapse to one symmetric pair",
    { scenario: "duplicate-collapse" },
    { ok: true },
  ),
  // TOP-016 — threshold boundary: > threshold retained, equal/below dropped.
  topoFixture(
    "TOP-016",
    "scores strictly above threshold retained, equal/below dropped",
    { scenario: "threshold-boundary" },
    { ok: true },
  ),
  // TOP-017 — multiple heads build independently and coexist in one graph.
  topoFixture(
    "TOP-017",
    "multiple heads build independently and coexist in one graph",
    { scenario: "many-heads" },
    { ok: true },
  ),
  // TOP-018 — large candidate sets remain capped per source/head.
  topoFixture(
    "TOP-018",
    "large candidate sets remain capped per source/head",
    { scenario: "large-cap" },
    { ok: true },
  ),
  // TOP-019 — the digest is stable across 1,000 repeated builds.
  topoFixture(
    "TOP-019",
    "the digest is stable across 1,000 repeated builds",
    { scenario: "digest-stable-1000" },
    { ok: true },
  ),
  // TOP-020 — infinite scores are rejected as TOP_SCORE_NONFINITE.
  topoFixture(
    "TOP-020",
    "infinite scores are rejected as TOP_SCORE_NONFINITE",
    { scenario: "infinite-reject" },
    { ok: false, code: "TOP_SCORE_NONFINITE" },
  ),
];

export const named = [
  // TOP-K-001 — seventeenth eligible neighbor per source/head excluded (top-k=16).
  topoFixture(
    "TOP-K-001",
    "the seventeenth eligible neighbor per source/head is excluded (named)",
    { scenario: "cap-seventeenth" },
    { ok: true },
  ),
  // TOP-TIE-002 — equal scores sort target IDs by unsigned bytes.
  topoFixture(
    "TOP-TIE-002",
    "equal scores sort target IDs by unsigned bytes (named)",
    { scenario: "stable-sort" },
    { ok: true },
  ),
  // TOP-KIND-003 — dependency one direction, contradiction two.
  topoFixture(
    "TOP-KIND-003",
    "dependency has one direction while contradiction has two (named)",
    { scenario: "direction-kind" },
    { ok: true },
  ),
];
