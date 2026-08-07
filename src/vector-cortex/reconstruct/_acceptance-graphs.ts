/**
 * reconstruct/_acceptance-graphs.ts — named ClosureGraph materializations for
 * the VC4C acceptance aggregator.
 *
 * Extracted from _acceptance-helpers.ts per the delegate-shell + impl pattern
 * (CLAUDE.md §6) so the helper file stays under the 300-line soft limit.
 */
import assert from "node:assert/strict";

import type { ClosureGraph } from "./types.js";
import type { ShardRange } from "../shards/types.js";
import type { ClosureNode } from "./types.js";

export function node(id: string, kind: ClosureNode["kind"], opts: Partial<ClosureNode> = {}): ClosureNode {
  return { id, kind, tokenEstimate: opts.tokenEstimate ?? 10, anchor: opts.anchor, resolvedAtMs: opts.resolvedAtMs, span: opts.span };
}
export function span(sessionId: string, seqStart: bigint, byteStart: number, len: number): ShardRange {
  return { sessionId, seqStart, seqEnd: seqStart, byteStart, byteEnd: byteStart + len };
}
export function edge(from: string, to: string, kind: ClosureGraph["edges"][number]["kind"]): ClosureGraph["edges"][number] {
  return { from, to, kind };
}

/** Materialize a named graph into a real ClosureGraph. */
export function materializeGraph(name: string): ClosureGraph {
  const cases: Record<string, ClosureGraph> = {
    chain: {
      sessionId: "s",
      nodes: [node("a", "event"), node("b", "event"), node("c", "event")],
      edges: [edge("b", "a", "depends"), edge("c", "b", "depends")],
    },
    diamond: {
      sessionId: "s",
      nodes: [node("top", "event"), node("l", "event"), node("r", "event"), node("bottom", "event")],
      edges: [edge("l", "top", "depends"), edge("r", "top", "depends"), edge("bottom", "l", "depends"), edge("bottom", "r", "depends")],
    },
    cycle: {
      sessionId: "s",
      nodes: [node("a", "event"), node("b", "event"), node("c", "event")],
      edges: [edge("b", "a", "depends"), edge("c", "b", "depends"), edge("a", "c", "depends")],
    },
    selfloop: {
      sessionId: "s",
      nodes: [node("a", "event")],
      edges: [edge("a", "a", "depends")],
    },
    parallel: {
      sessionId: "s",
      nodes: [node("a", "event"), node("b", "event"), node("x", "event"), node("y", "event")],
      edges: [edge("b", "a", "depends"), edge("y", "x", "depends")],
    },
    prereq: {
      sessionId: "s",
      nodes: [node("dependent", "event"), node("prereq", "event")],
      edges: [edge("prereq", "dependent", "depends")],
    },
    leaf: {
      sessionId: "s",
      nodes: [node("only", "event")],
      edges: [],
    },
    scrambled: {
      sessionId: "s",
      nodes: [node("a", "event"), node("m", "event"), node("z", "event")],
      edges: [edge("m", "a", "depends"), edge("z", "m", "depends")],
    },
    "dangling-edge": {
      sessionId: "s",
      nodes: [node("a", "event")],
      edges: [edge("a", "ghost", "depends")],
    },
    toolpair: {
      sessionId: "s",
      nodes: [node("toolcall", "event"), node("toolresult", "event")],
      edges: [edge("toolcall", "toolresult", "tool-pair")],
    },
    anchored: {
      sessionId: "s",
      nodes: [node("a", "event"), node("anchor", "event", { anchor: true })],
      edges: [edge("a", "anchor", "depends")],
    },
    "anchor-deps": {
      sessionId: "s",
      nodes: [node("a", "event"), node("anchor", "event", { anchor: true }), node("anchordep", "event", { anchor: true })],
      edges: [edge("anchor", "a", "depends"), edge("anchordep", "anchor", "depends")],
    },
    "toolpair-transitive": {
      sessionId: "s",
      nodes: [node("toolcall", "event"), node("toolresult", "event"), node("shareddep", "event")],
      edges: [edge("toolcall", "toolresult", "tool-pair"), edge("shareddep", "toolcall", "depends"), edge("shareddep", "toolresult", "depends")],
    },
    "two-pairs": {
      sessionId: "s",
      nodes: [node("a", "event"), node("b", "event"), node("c", "event"), node("d", "event")],
      edges: [edge("a", "b", "tool-pair"), edge("c", "d", "tool-pair")],
    },
    "anchor-pair": {
      sessionId: "s",
      nodes: [node("toolcall", "event"), node("toolresult", "event"), node("anchor", "event", { anchor: true })],
      edges: [edge("toolcall", "toolresult", "tool-pair"), edge("anchor", "toolcall", "depends")],
    },
    chain8: {
      sessionId: "s",
      nodes: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => node(`n${i}`, "event")),
      edges: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => edge(`n${i + 1}`, `n${i}`, "depends")),
    },
    "pair-dep": {
      sessionId: "s",
      nodes: [node("toolcall", "event"), node("toolresult", "event"), node("common", "event")],
      edges: [edge("toolcall", "toolresult", "tool-pair"), edge("common", "toolcall", "depends"), edge("common", "toolresult", "depends")],
    },
    overlap: {
      sessionId: "s",
      nodes: [node("a", "event"), node("b", "event"), node("c", "event"), node("d", "event")],
      edges: [edge("a", "c", "depends"), edge("b", "c", "depends"), edge("b", "d", "depends")],
    },
    "contra-explicit": {
      sessionId: "s",
      nodes: [node("a", "event"), node("loser", "exact", { resolvedAtMs: 100n }), node("winner", "exact", { resolvedAtMs: 200n })],
      edges: [edge("loser", "winner", "contradicts"), edge("loser", "a", "depends"), edge("winner", "loser", "depends")],
      resolutions: [{ loserId: "loser", winnerId: "winner" }],
    },
    "contra-later": {
      sessionId: "s",
      nodes: [node("a", "event"), node("early", "exact", { resolvedAtMs: 100n }), node("late", "exact", { resolvedAtMs: 200n })],
      edges: [edge("early", "late", "contradicts"), edge("early", "a", "depends"), edge("late", "early", "depends")],
    },
    "contra-tie": {
      sessionId: "s",
      nodes: [node("a", "event"), node("x", "exact", { resolvedAtMs: 100n }), node("y", "exact", { resolvedAtMs: 100n })],
      edges: [edge("x", "y", "contradicts"), edge("x", "a", "depends"), edge("y", "x", "depends")],
    },
    "contra-non-exact": {
      sessionId: "s",
      nodes: [node("a", "event"), node("x", "semantic", { resolvedAtMs: 100n }), node("y", "semantic", { resolvedAtMs: 200n })],
      edges: [edge("x", "y", "contradicts"), edge("x", "a", "depends"), edge("y", "x", "depends")],
    },
    "contra-unselected": {
      sessionId: "s",
      nodes: [node("a", "event"), node("x", "exact", { resolvedAtMs: 100n }), node("y", "exact", { resolvedAtMs: 200n })],
      edges: [edge("x", "y", "contradicts"), edge("a", "x", "depends")],
    },
    "contra-semantic": {
      sessionId: "s",
      nodes: [node("a", "event"), node("x", "semantic", { resolvedAtMs: 100n }), node("y", "exact", { resolvedAtMs: 200n })],
      edges: [edge("x", "y", "contradicts"), edge("x", "a", "depends"), edge("y", "x", "depends")],
    },
    "contra-deps": {
      sessionId: "s",
      nodes: [node("a", "event"), node("early", "exact", { resolvedAtMs: 100n }), node("late", "exact", { resolvedAtMs: 200n }), node("dep", "event")],
      edges: [edge("early", "late", "contradicts"), edge("early", "a", "depends"), edge("dep", "early", "depends"), edge("late", "early", "depends")],
    },
    tokened: {
      sessionId: "s",
      nodes: [node("a", "event", { tokenEstimate: 10 }), node("b", "event", { tokenEstimate: 10 }), node("c", "event", { tokenEstimate: 10 })],
      edges: [edge("b", "a", "depends"), edge("c", "b", "depends")],
    },
    ordered: {
      sessionId: "s",
      nodes: [node("a", "semantic", { span: span("s", 1n, 0, 6) }), node("b", "exact", { span: span("s", 1n, 6, 6) }), node("c", "exact", { span: span("s", 1n, 12, 6) })],
      edges: [edge("b", "a", "depends"), edge("c", "b", "depends")],
    },
    "scrambled-spans": {
      sessionId: "s",
      nodes: [node("c", "exact", { span: span("s", 1n, 12, 6) }), node("a", "semantic", { span: span("s", 1n, 0, 6) }), node("b", "exact", { span: span("s", 1n, 6, 6) })],
      edges: [],
    },
    protected: {
      sessionId: "s",
      nodes: [node("a", "exact", { span: span("s", 1n, 0, 6) }), node("b", "exact", { span: span("s", 1n, 6, 6) })],
      edges: [edge("b", "a", "depends")],
    },
    empty: { sessionId: "s", nodes: [], edges: [] },
    reverse: {
      sessionId: "s",
      nodes: [node("c", "exact", { span: span("s", 1n, 12, 6) }), node("b", "exact", { span: span("s", 1n, 6, 6) }), node("a", "semantic", { span: span("s", 1n, 0, 6) })],
      edges: [],
    },
    adjacent: {
      sessionId: "s",
      nodes: [node("a", "exact", { span: span("s", 1n, 0, 7) }), node("b", "exact", { span: span("s", 1n, 7, 14) })],
      edges: [edge("b", "a", "depends")],
    },
    single: { sessionId: "s", nodes: [node("a", "exact", { span: span("s", 1n, 0, 6) })], edges: [] },
    mixed: {
      sessionId: "s",
      nodes: [node("a", "exact", { span: span("s", 1n, 0, 6) }), node("b", "exact", { span: span("s", 1n, 6, 6) }), node("c", "semantic", { span: span("s", 1n, 12, 6) })],
      edges: [edge("b", "a", "depends"), edge("c", "b", "depends")],
    },
  };
  const g = cases[name];
  assert.ok(g, `graph materializer missing for "${name}"`);
  return g;
}
