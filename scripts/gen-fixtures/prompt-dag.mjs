// VC5A prompt-DAG fixtures (`conformance/vector-cortex/v2/prompt-dag/`).
//
// Owner VC5A (PromptDagV1 builder + validator). Each fixture declares a build /
// validation condition the acceptance test executes against the REAL prompt-dag
// module (src/vector-cortex/prompt-dag/{builder,validator}.js), no mocks.
// `input.graph` names a graph the test materializes; `expected.ok` pins the
// successful behavior (optionally the exact stable Kahn `order`) or the exact
// failure `code` (DAG_CYCLE / DAG_MIXED_SESSION / DAG_DUPLICATE_ID /
// DAG_MISSING_ENDPOINT / DAG_INVALID_SPAN / DAG_SPAN_DIGEST_CONFLICT /
// DAG_REVERSED_PRECEDES / DAG_TOOL_PAIR_SPLIT / DAG_UNKNOWN_INCOMPATIBLE).
//
// DAG-001..030 pin builder structural rejection and validator ordering: stable
// Kahn order with (startSeq, syntheticOrdinal, id bytes) ties, single-session
// enforcement, synthetic ordering, cycle detection. The NAMED row
// (DAG-CYCLE-001) pins the sprint's headline assertion: a dependency cycle
// rejects with DAG_CYCLE.

import { producer } from "./common.mjs";

const PROMPT_DAG_SCHEMA = "schemas/prompt-dag-fixture.schema.json";

function dagFixture(id, assertion, input, expected) {
  return { id, schema: PROMPT_DAG_SCHEMA, producer, assertion, kind: "prompt-dag", input, expected };
}

export const fixtures = [
  // ── Builder: structural acceptance (DAG-001..010) ──────────────────────────
  dagFixture("DAG-001", "a single-session linear chain builds and orders by source seq",
    { scenario: "build-linear", graph: "linear" },
    { ok: true, order: ["a", "b", "c"] }),
  dagFixture("DAG-002", "a node whose span names another session rejects with DAG_MIXED_SESSION",
    { scenario: "build-mixed-session", graph: "mixed-session" },
    { ok: false, code: "DAG_MIXED_SESSION" }),
  dagFixture("DAG-003", "two nodes sharing an id reject with DAG_DUPLICATE_ID",
    { scenario: "build-duplicate-id", graph: "duplicate-id" },
    { ok: false, code: "DAG_DUPLICATE_ID" }),
  dagFixture("DAG-004", "an edge naming an absent node rejects with DAG_MISSING_ENDPOINT",
    { scenario: "build-missing-endpoint", graph: "missing-endpoint" },
    { ok: false, code: "DAG_MISSING_ENDPOINT" }),
  dagFixture("DAG-005", "a reversed span range rejects with DAG_INVALID_SPAN",
    { scenario: "build-invalid-span", graph: "invalid-span" },
    { ok: false, code: "DAG_INVALID_SPAN" }),
  dagFixture("DAG-006", "a synthetic node carrying a span rejects with DAG_INVALID_SPAN",
    { scenario: "build-synthetic-with-span", graph: "synthetic-span" },
    { ok: false, code: "DAG_INVALID_SPAN" }),
  dagFixture("DAG-007", "overlapping spans pinning different digests reject with DAG_SPAN_DIGEST_CONFLICT",
    { scenario: "build-digest-conflict", graph: "digest-conflict" },
    { ok: false, code: "DAG_SPAN_DIGEST_CONFLICT" }),
  dagFixture("DAG-008", "overlapping spans agreeing on the digest are accepted",
    { scenario: "build-digest-agree", graph: "digest-agree" },
    { ok: true }),
  dagFixture("DAG-009", "incompatibleWith naming an absent node rejects with DAG_UNKNOWN_INCOMPATIBLE",
    { scenario: "build-unknown-incompatible", graph: "unknown-incompatible" },
    { ok: false, code: "DAG_UNKNOWN_INCOMPATIBLE" }),
  dagFixture("DAG-010", "a tool-pair edge missing an endpoint rejects with DAG_TOOL_PAIR_SPLIT",
    { scenario: "build-tool-pair-split", graph: "tool-pair-split" },
    { ok: false, code: "DAG_TOOL_PAIR_SPLIT" }),

  // ── Validator: stable Kahn order (DAG-011..020) ────────────────────────────
  dagFixture("DAG-011", "a dependency cycle rejects with DAG_CYCLE",
    { scenario: "validate-cycle", graph: "cycle" },
    { ok: false, code: "DAG_CYCLE" }),
  dagFixture("DAG-012", "a self-loop is a cycle and rejects with DAG_CYCLE",
    { scenario: "validate-self-loop", graph: "selfloop" },
    { ok: false, code: "DAG_CYCLE" }),
  dagFixture("DAG-013", "zero-indegree ties break by node-ID bytes",
    { scenario: "validate-id-tie", graph: "id-tie" },
    { ok: true, order: ["aa", "bb", "cc"] }),
  dagFixture("DAG-014", "nodes order by source seq before ID bytes",
    { scenario: "validate-seq-before-id", graph: "seq-before-id" },
    { ok: true, order: ["z", "y", "x"] }),
  dagFixture("DAG-015", "synthetic nodes order after every spanned node",
    { scenario: "validate-synthetic-last", graph: "synthetic-last" },
    { ok: true, order: ["a", "b", "syn"] }),
  dagFixture("DAG-016", "synthetic nodes tie-break by syntheticOrdinal then ID bytes",
    { scenario: "validate-synthetic-ordinal", graph: "synthetic-ordinal" },
    { ok: true, order: ["a", "s1", "s2"] }),
  dagFixture("DAG-017", "a diamond dependency emits a single stable order",
    { scenario: "validate-diamond", graph: "diamond" },
    { ok: true, order: ["top", "l", "r", "bottom"] }),
  dagFixture("DAG-018", "a contradicts edge does not constrain the topological order",
    { scenario: "validate-contradicts-not-ordering", graph: "contradicts" },
    { ok: true, order: ["a", "b"] }),
  dagFixture("DAG-019", "two contradicting nodes never manufacture a phantom cycle",
    { scenario: "validate-contradicts-no-cycle", graph: "contradicts-cycle" },
    { ok: true }),
  dagFixture("DAG-020", "a precedes edge pointing backward rejects with DAG_REVERSED_PRECEDES",
    { scenario: "validate-reversed-precedes", graph: "reversed-precedes" },
    { ok: false, code: "DAG_REVERSED_PRECEDES" }),

  // ── Determinism + structural invariants (DAG-021..030) ─────────────────────
  dagFixture("DAG-021", "the emitted order is invariant to input node permutation",
    { scenario: "validate-permutation-invariant", graph: "scrambled", permute: true },
    { ok: true, permutationInvariant: true }),
  dagFixture("DAG-022", "the emitted order is invariant to input edge permutation",
    { scenario: "validate-permutation-invariant", graph: "linear", permute: true },
    { ok: true, permutationInvariant: true }),
  dagFixture("DAG-023", "an empty DAG validates to an empty order",
    { scenario: "validate-empty", graph: "empty" },
    { ok: true, order: [] }),
  dagFixture("DAG-024", "a single node validates to itself",
    { scenario: "validate-single", graph: "single" },
    { ok: true, order: ["a"] }),
  dagFixture("DAG-025", "disconnected components both appear in source order",
    { scenario: "validate-disconnected", graph: "disconnected" },
    { ok: true, order: ["a", "x", "b", "y"] }),
  dagFixture("DAG-026", "a tool-pair edge orders the pair adjacently",
    { scenario: "validate-tool-pair-order", graph: "toolpair" },
    { ok: true, order: ["toolcall", "toolresult"] }),
  dagFixture("DAG-027", "a deep chain (8 hops) orders fully and terminates",
    { scenario: "validate-deep-chain", graph: "chain8" },
    { ok: true, orderLength: 9 }),
  dagFixture("DAG-028", "the DAG digest is stable across input permutation",
    { scenario: "validate-digest-stable", graph: "scrambled", permute: true },
    { ok: true, digestStable: true }),
  dagFixture("DAG-029", "changing a node payload digest changes the DAG digest",
    { scenario: "validate-digest-sensitive", graph: "linear" },
    { ok: true, digestSensitive: true }),
  dagFixture("DAG-030", "every accepted DAG emits an order covering every node exactly once",
    { scenario: "validate-order-total", graph: "diamond" },
    { ok: true, orderIsTotal: true }),
];

export const named = [
  dagFixture(
    "DAG-CYCLE-001",
    "dependency cycle rejects with DAG_CYCLE (named)",
    { scenario: "validate-cycle", graph: "cycle" },
    { ok: false, code: "DAG_CYCLE" },
  ),
];
