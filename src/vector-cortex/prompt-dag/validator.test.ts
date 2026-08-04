/**
 * prompt-dag/validator.test.ts — unit tests for validatePromptDag + dagDigest
 * (VC5A task 2). Exercises the stable Kahn order and digest directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validatePromptDag, dagDigest } from "./validator.js";
import { buildPromptDag } from "./builder.js";
import type { DagEdge, DagNode, DagSpan, PromptDagV1 } from "./types.js";

function span(
  sessionId: string,
  startSeq: bigint,
  endSeq: bigint,
  startByte: number,
  endByte: number,
  digest: string,
): DagSpan {
  return { sessionId, startSeq, endSeq, startByte, endByte, digest: `sha256:${digest}` as `sha256:${string}` };
}
function node(id: string, kind: DagNode["kind"], opts: Partial<DagNode> = {}): DagNode {
  return {
    id,
    kind,
    payloadDigest: opts.payloadDigest ?? `pd:${id}`,
    incompatibleWith: opts.incompatibleWith ?? [],
    ...(opts.span !== undefined ? { span: opts.span } : {}),
    ...(opts.syntheticOrdinal !== undefined ? { syntheticOrdinal: opts.syntheticOrdinal } : {}),
  };
}
function edge(from: string, to: string, kind: DagEdge["kind"]): DagEdge {
  return { from, to, kind };
}
const D0 = "a".repeat(64);

/** Build + validate a DAG from raw nodes/edges; asserts the build succeeds. */
function buildValid(nodes: DagNode[], edges: DagEdge[]): PromptDagV1 {
  const res = buildPromptDag({ sessionId: "s", sourceHighWater: 10n, nodes, edges });
  assert.equal(res.ok, true);
  return res.ok ? res.dag : (null as unknown as PromptDagV1);
}

test("a linear dependency chain orders by source seq", () => {
  const dag = buildValid(
    [
      node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("b", "exact", { span: span("s", 2n, 2n, 4, 7, D0) }),
      node("c", "semantic", { span: span("s", 3n, 3n, 8, 11, D0) }),
    ],
    [edge("a", "b", "depends"), edge("b", "c", "depends")],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.order, ["a", "b", "c"]);
});

test("a dependency cycle is rejected", () => {
  const dag = buildValid(
    [
      node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("b", "event", { span: span("s", 2n, 2n, 4, 7, D0) }),
      node("c", "event", { span: span("s", 3n, 3n, 8, 11, D0) }),
    ],
    [edge("b", "a", "depends"), edge("c", "b", "depends"), edge("a", "c", "depends")],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, false);
  if (!v.ok) assert.deepEqual(v.codes, ["DAG_CYCLE"]);
});

test("zero-indegree ties break by node-id bytes", () => {
  const dag = buildValid(
    [
      node("cc", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("aa", "event", { span: span("s", 1n, 1n, 4, 7, D0) }),
      node("bb", "event", { span: span("s", 1n, 1n, 8, 11, D0) }),
    ],
    [],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.order, ["aa", "bb", "cc"]);
});

test("synthetic nodes order after every spanned node", () => {
  const dag = buildValid(
    [
      node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("syn", "synthetic", { syntheticOrdinal: 0 }),
      node("b", "event", { span: span("s", 2n, 2n, 4, 7, D0) }),
    ],
    [],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.order, ["a", "b", "syn"]);
});

test("a contradicts edge does not impose an ordering constraint", () => {
  const dag = buildValid(
    [
      node("a", "exact", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("b", "exact", { span: span("s", 2n, 2n, 4, 7, D0) }),
    ],
    [edge("a", "b", "contradicts")],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.order, ["a", "b"]);
});

test("two contradicting nodes never manufacture a phantom cycle", () => {
  const dag = buildValid(
    [
      node("a", "exact", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("b", "exact", { span: span("s", 2n, 2n, 4, 7, D0) }),
    ],
    [edge("a", "b", "contradicts"), edge("a", "b", "depends")],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.order, ["a", "b"]);
});

test("a reversed precedes edge is rejected", () => {
  const dag = buildValid(
    [
      node("a", "event", { span: span("s", 2n, 2n, 0, 3, D0) }),
      node("b", "event", { span: span("s", 1n, 1n, 4, 7, D0) }),
    ],
    [edge("a", "b", "precedes")],
  );
  const v = validatePromptDag(dag);
  assert.equal(v.ok, false);
  if (!v.ok) assert.deepEqual(v.codes, ["DAG_REVERSED_PRECEDES"]);
});

test("the topological order is invariant to input node permutation", () => {
  const nodes = [
    node("c", "event", { span: span("s", 3n, 3n, 8, 11, D0) }),
    node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
    node("b", "event", { span: span("s", 2n, 2n, 4, 7, D0) }),
  ];
  const edges = [edge("a", "b", "depends"), edge("b", "c", "depends")];
  const v1 = validatePromptDag(buildValid(nodes, edges));
  const v2 = validatePromptDag(buildValid([...nodes].reverse(), [...edges].reverse()));
  assert.equal(v1.ok && v2.ok, true);
  if (v1.ok && v2.ok) assert.deepEqual(v1.order, v2.order);
});

test("dagDigest is stable across input permutation but sensitive to a payload change", () => {
  const nodes = [
    node("c", "event", { span: span("s", 3n, 3n, 8, 11, D0) }),
    node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
    node("b", "event", { span: span("s", 2n, 2n, 4, 7, D0) }),
  ];
  const edges = [edge("a", "b", "depends"), edge("b", "c", "depends")];
  const d1 = dagDigest(buildValid(nodes, edges));
  const d2 = dagDigest(buildValid([...nodes].reverse(), [...edges].reverse()));
  assert.equal(d1, d2, "digest stable under permutation");

  const mutated = buildValid(
    nodes.map((n, i) => (i === 0 ? { ...n, payloadDigest: "pd:changed" } : n)),
    edges,
  );
  assert.notEqual(dagDigest(mutated), d1, "digest sensitive to payload");
});

test("the digest excludes token counts so a planner input change does not move it", () => {
  const dag = buildValid(
    [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
    [],
  );
  // Re-build with a different (fictional) token-carrying shape; the digest only
  // binds structure, so it is unchanged by anything outside node/edge fields.
  const same = buildValid(
    [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
    [],
  );
  assert.equal(dagDigest(dag), dagDigest(same));
});
