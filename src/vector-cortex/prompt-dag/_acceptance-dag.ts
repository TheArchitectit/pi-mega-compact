/**
 * prompt-dag/_acceptance-dag.ts — declarative DAG materialization + scenario
 * driver for VC5A acceptance rows.
 *
 * Turns named graph scenarios into real `PromptDagV1` values and drives them
 * through the REAL build/validate logic. Deterministic helpers (eq/shuffle)
 * live in `_acceptance-shuffle.ts`.
 */
import assert from "node:assert/strict";
import { buildPromptDag, compareNodes, compareEdges } from "./builder.js";
import { validatePromptDag, dagDigest } from "./validator.js";
import type { DagEdge, DagNode, DagSpan, PromptDagV1 } from "./types.js";
import type { DagFixture } from "./_acceptance-fixture.js";
import { eq, shuffle } from "./_acceptance-shuffle.js";

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
function node(
  id: string,
  kind: DagNode["kind"],
  opts: Partial<DagNode> = {},
): DagNode {
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
const D1 = "b".repeat(64);

export interface MaterializedDag {
  dag: PromptDagV1;
  buildOk: boolean;
  buildCodes: readonly string[];
}

/** Materialize a named graph into a built PromptDagV1 + a validator order. */
export function materializeDag(name: string): MaterializedDag {
  const cases: Record<string, { sessionId: string; nodes: DagNode[]; edges: DagEdge[] }> = {
    linear: {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "exact", { span: span("s", 2n, 2n, 3, 6, D0) }),
        node("c", "semantic", { span: span("s", 3n, 3n, 6, 9, D0) }),
      ],
      edges: [edge("a", "b", "depends"), edge("b", "c", "depends")],
    },
    "mixed-session": {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        // A span claiming a foreign session — single-session violation.
        node("b", "exact", { span: span("OTHER", 2n, 2n, 0, 3, D0) }),
      ],
      edges: [],
    },
    "duplicate-id": {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("a", "exact", { span: span("s", 2n, 2n, 0, 3, D1) }),
      ],
      edges: [],
    },
    "missing-endpoint": {
      sessionId: "s",
      nodes: [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
      edges: [edge("a", "ghost", "depends")],
    },
    "invalid-span": {
      sessionId: "s",
      nodes: [node("a", "event", { span: span("s", 3n, 1n, 9, 0, D0) })],
      edges: [],
    },
    "synthetic-span": {
      sessionId: "s",
      nodes: [
        node("a", "synthetic", { syntheticOrdinal: 0, span: span("s", 1n, 1n, 0, 3, D0) }),
      ],
      edges: [],
    },
    "digest-conflict": {
      sessionId: "s",
      nodes: [
        node("a", "exact", { span: span("s", 1n, 1n, 0, 6, D0) }),
        node("b", "exact", { span: span("s", 2n, 2n, 3, 9, D1) }),
      ],
      edges: [],
    },
    "digest-agree": {
      sessionId: "s",
      nodes: [
        node("a", "exact", { span: span("s", 1n, 1n, 0, 6, D0) }),
        node("b", "exact", { span: span("s", 2n, 2n, 3, 9, D0) }),
      ],
      edges: [],
    },
    "unknown-incompatible": {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0), incompatibleWith: ["ghost"] }),
        node("b", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
      ],
      edges: [],
    },
    "tool-pair-split": {
      sessionId: "s",
      nodes: [node("toolcall", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
      edges: [edge("toolcall", "toolresult", "tool-pair")],
    },
    cycle: {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
        node("c", "event", { span: span("s", 3n, 3n, 0, 3, D0) }),
      ],
      edges: [edge("b", "a", "depends"), edge("c", "b", "depends"), edge("a", "c", "depends")],
    },
    selfloop: {
      sessionId: "s",
      nodes: [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
      edges: [edge("a", "a", "depends")],
    },
    "id-tie": {
      sessionId: "s",
      nodes: [
        node("aa", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("bb", "event", { span: span("s", 1n, 1n, 3, 6, D1) }),
        node("cc", "event", { span: span("s", 1n, 1n, 6, 9, D0) }),
      ],
      edges: [],
    },
    "seq-before-id": {
      sessionId: "s",
      // Earlier seq sorts first even though IDs sort the other way.
      nodes: [
        node("z", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("y", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
        node("x", "event", { span: span("s", 3n, 3n, 0, 3, D0) }),
      ],
      edges: [],
    },
    "synthetic-last": {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
        node("syn", "synthetic", { syntheticOrdinal: 0 }),
      ],
      edges: [],
    },
    "synthetic-ordinal": {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("s1", "synthetic", { syntheticOrdinal: 1 }),
        node("s2", "synthetic", { syntheticOrdinal: 2 }),
      ],
      edges: [],
    },
    diamond: {
      sessionId: "s",
      nodes: [
        node("top", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("l", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
        node("r", "event", { span: span("s", 3n, 3n, 0, 3, D0) }),
        node("bottom", "event", { span: span("s", 4n, 4n, 0, 3, D1) }),
      ],
      edges: [
        edge("top", "l", "depends"),
        edge("top", "r", "depends"),
        edge("l", "bottom", "depends"),
        edge("r", "bottom", "depends"),
      ],
    },
    contradicts: {
      sessionId: "s",
      nodes: [
        node("a", "exact", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "exact", { span: span("s", 2n, 2n, 0, 3, D1) }),
      ],
      edges: [edge("a", "b", "contradicts")],
    },
    "contradicts-cycle": {
      sessionId: "s",
      nodes: [
        node("a", "exact", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "exact", { span: span("s", 2n, 2n, 0, 3, D1) }),
      ],
      // A contradicts edge plus a depends edge: a real cycle would need the
      // depends to form a loop, but here only `a->b` depends, so no cycle.
      edges: [edge("a", "b", "contradicts"), edge("a", "b", "depends")],
    },
    "reversed-precedes": {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 2n, 2n, 0, 3, D0) }),
        node("b", "event", { span: span("s", 1n, 1n, 0, 3, D1) }),
      ],
      // b's source position is EARLIER than a's, so a->b precedes is backward.
      edges: [edge("a", "b", "precedes")],
    },
    scrambled: {
      sessionId: "s",
      nodes: [
        node("c", "event", { span: span("s", 3n, 3n, 6, 9, D0) }),
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "event", { span: span("s", 2n, 2n, 3, 6, D1) }),
      ],
      edges: [edge("a", "b", "depends"), edge("b", "c", "depends")],
    },
    empty: { sessionId: "s", nodes: [], edges: [] },
    single: {
      sessionId: "s",
      nodes: [node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) })],
      edges: [],
    },
    disconnected: {
      sessionId: "s",
      nodes: [
        node("a", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("b", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
        node("x", "event", { span: span("s", 1n, 1n, 3, 6, D0) }),
        node("y", "event", { span: span("s", 2n, 2n, 3, 6, D1) }),
      ],
      edges: [],
    },
    toolpair: {
      sessionId: "s",
      nodes: [
        node("toolcall", "event", { span: span("s", 1n, 1n, 0, 3, D0) }),
        node("toolresult", "event", { span: span("s", 2n, 2n, 0, 3, D1) }),
      ],
      edges: [edge("toolcall", "toolresult", "tool-pair")],
    },
    chain8: {
      sessionId: "s",
      nodes: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
        node(`n${i}`, "event", { span: span("s", BigInt(i + 1), BigInt(i + 1), 0, 3, D0) }),
      ),
      edges: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => edge(`n${i + 1}`, `n${i}`, "depends")),
    },
  };
  const g = cases[name];
  assert.ok(g, `dag materializer missing for "${name}"`);
  // Give every node a DISTINCT, non-overlapping byte window so the builder's
  // digest-conflict rule (which only fires on genuinely shared bytes) does not
  // misfire on adjacent ordering-test nodes. The two digest-* graphs intentionally
  // KEEP overlapping spans to exercise that rule, so they are excluded here.
  const overlapIntentional = name === "digest-conflict" || name === "digest-agree";
  const nodes = overlapIntentional
    ? g.nodes
    : g.nodes.map((n, i) =>
        n.span === undefined
          ? n
          : { ...n, span: { ...n.span, startByte: i * 4, endByte: i * 4 + 4 } },
      );
  const built = buildPromptDag({
    sessionId: g.sessionId,
    sourceHighWater: 100n,
    nodes,
    edges: g.edges,
  });
  return {
    buildOk: built.ok,
    buildCodes: built.ok ? [] : built.codes,
    dag: built.ok
      ? built.dag
      : {
          schema: "prompt-dag-v1",
          sessionId: g.sessionId,
          sourceHighWater: 100n,
          nodes: [...g.nodes].sort(compareNodes),
          edges: [...g.edges].sort(compareEdges),
        },
  };
}

/** Validate a materialized DAG, returning order / failure codes / digest. */
export function runDagScenario(fx: DagFixture): {
  ok: boolean;
  code?: string;
  order?: string[];
  orderLength?: number;
  permutationInvariant?: boolean;
  digestStable?: boolean;
  digestSensitive?: boolean;
  orderIsTotal?: boolean;
} {
  const { scenario, graph, mutateDigest } = fx.input;
  const base = materializeDag(graph ?? "linear");

  // Structural REJECTION scenarios stop at the builder (no validation). Build
  // ACCEPTANCE scenarios (build-linear / build-digest-agree) succeed and must
  // still be validated for their topological order.
  const structuralReject = [
    "build-mixed-session",
    "build-duplicate-id",
    "build-missing-endpoint",
    "build-invalid-span",
    "build-synthetic-with-span",
    "build-digest-conflict",
    "build-unknown-incompatible",
    "build-tool-pair-split",
  ];
  if (structuralReject.includes(scenario)) {
    // Prefer the more specific tool-pair rejection when both it and a generic
    // missing-endpoint code are present (a split tool pair is also missing an
    // endpoint, but the tool-pair split is the precise failure).
    const codes = base.buildCodes;
    const code = codes.includes("DAG_TOOL_PAIR_SPLIT")
      ? "DAG_TOOL_PAIR_SPLIT"
      : codes[0];
    return { ok: base.buildOk, code };
  }

  // A built DAG is required for validation scenarios.
  assert.ok(base.buildOk, `${fx.id}: builder must succeed before validation`);
  const dag = base.dag;
  const v = validatePromptDag(dag);
  const digest = dagDigest(dag);

  if (fx.expected.permutationInvariant) {
    // Re-run with a shuffled node/edge array; order + digest must be identical.
    const permNodes = shuffle([...dag.nodes]);
    const permEdges = shuffle([...dag.edges]);
    const perm = buildPromptDag({
      sessionId: dag.sessionId,
      sourceHighWater: dag.sourceHighWater,
      nodes: permNodes,
      edges: permEdges,
    });
    assert.ok(perm.ok, `${fx.id}: permuted build must succeed`);
    const vPerm = validatePromptDag(perm.dag);
    const orderSame = v.ok && vPerm.ok && eq(v.order, vPerm.order);
    const digestSame = dagDigest(perm.dag) === digest;
    return { ok: true, permutationInvariant: orderSame, digestStable: digestSame };
  }

  if (fx.expected.digestStable) {
    const perm = buildPromptDag({
      sessionId: dag.sessionId,
      sourceHighWater: dag.sourceHighWater,
      nodes: shuffle([...dag.nodes]),
      edges: shuffle([...dag.edges]),
    });
    assert.ok(perm.ok);
    return { ok: true, digestStable: dagDigest(perm.dag) === digest };
  }

  if (fx.expected.digestSensitive) {
    const mutated = {
      ...dag,
      nodes: dag.nodes.map((n, i) =>
        i === 0 ? { ...n, payloadDigest: `pd:mutated-${n.id}` } : n,
      ),
    };
    return { ok: true, digestSensitive: dagDigest(mutated) !== digest };
  }

  if (fx.expected.orderIsTotal) {
    const ok = v.ok && v.order.length === dag.nodes.length && new Set(v.order).size === dag.nodes.length;
    return { ok, orderIsTotal: ok };
  }

  if (fx.expected.orderLength !== undefined) {
    return { ok: v.ok, orderLength: v.ok ? v.order.length : 0 };
  }

  // Plain order / failure-code scenarios.
  if (!v.ok) return { ok: false, code: v.codes[0] };
  void mutateDigest;
  return { ok: true, order: [...v.order] };
}
