/**
 * prompt-dag/builder.test.ts — unit tests for buildPromptDag (VC5A task 2).
 * Exercises the structural gate directly against the REAL builder, no mocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPromptDag, compareNodes, compareEdges } from "./builder.js";
import type { DagEdge, DagNode, DagSpan } from "./types.js";

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
  };
}
function edge(from: string, to: string, kind: DagEdge["kind"]): DagEdge {
  return { from, to, kind };
}
const D0 = "a".repeat(64);
const D1 = "b".repeat(64);

test("a well-formed single-session DAG builds and emits canonical order", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [
      node("b", "exact", { span: span("s", 2n, 2n, 4, 7, D1) }),
      node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
    ],
    edges: [edge("b", "a", "depends")],
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.dag.nodes.map((n) => n.id), ["a", "b"]);
    assert.equal(res.dag.schema, "prompt-dag-v1");
  }
});

test("a node whose span names another session is rejected", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [node("a", "event", { span: span("OTHER", 1n, 1n, 0, 3, D0) })],
    edges: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_MIXED_SESSION"));
});

test("duplicate node ids are rejected", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [
      node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
      node("a", "exact", { span: span("s", 2n, 2n, 0, 3, D1) }),
    ],
    edges: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_DUPLICATE_ID"));
});

test("an edge naming an absent node is rejected (missing endpoint)", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
    edges: [edge("a", "ghost", "depends")],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_MISSING_ENDPOINT"));
});

test("a reversed span range is rejected", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [node("a", "event", { span: span("s", 3n, 1n, 0, 3, D0) })],
    edges: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_INVALID_SPAN"));
});

test("a synthetic node carrying a span is rejected", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [node("syn", "synthetic", { syntheticOrdinal: 0, span: span("s", 1n, 1n, 0, 3, D0) })],
    edges: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_INVALID_SPAN"));
});

test("overlapping spans with differing digests are rejected", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [
      node("a", "exact", { span: span("s", 1n, 1n, 0, 6, D0) }),
      node("b", "exact", { span: span("s", 2n, 2n, 3, 9, D1) }),
    ],
    edges: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_SPAN_DIGEST_CONFLICT"));
});

test("overlapping spans agreeing on the digest are accepted", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [
      node("a", "exact", { span: span("s", 1n, 1n, 0, 6, D0) }),
      node("b", "exact", { span: span("s", 2n, 2n, 3, 9, D0) }),
    ],
    edges: [],
  });
  assert.equal(res.ok, true);
});

test("incompatibleWith naming an absent node is rejected", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0), incompatibleWith: ["ghost"] })],
    edges: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.codes.includes("DAG_UNKNOWN_INCOMPATIBLE"));
});

test("a tool-pair edge missing an endpoint is rejected with the tool-pair code", () => {
  const res = buildPromptDag({
    sessionId: "s",
    sourceHighWater: 10n,
    nodes: [node("toolcall", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
    edges: [edge("toolcall", "toolresult", "tool-pair")],
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.codes.includes("DAG_TOOL_PAIR_SPLIT"));
    assert.ok(res.codes.includes("DAG_MISSING_ENDPOINT"));
  }
});

test("compareNodes orders by source seq then syntheticOrdinal then id bytes", () => {
  const a = node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) });
  const b = node("b", "event", { span: span("s", 2n, 2n, 0, 3, D0) });
  const syn = node("syn", "synthetic", { syntheticOrdinal: 0 });
  assert.ok(compareNodes(a, b) < 0);
  assert.ok(compareNodes(b, syn) < 0, "spanned nodes precede synthetics");
  assert.ok(compareNodes(a, a) === 0);
});

test("compareEdges orders by from then to then kind", () => {
  const e1 = edge("a", "b", "depends");
  const e2 = edge("a", "b", "precedes");
  const e3 = edge("a", "c", "depends");
  assert.ok(compareEdges(e1, e2) < 0, "kind is last tie-break");
  assert.ok(compareEdges(e2, e3) < 0, "to precedes kind");
});
