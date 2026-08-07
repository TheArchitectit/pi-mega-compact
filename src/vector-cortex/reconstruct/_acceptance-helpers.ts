/**
 * reconstruct/_acceptance-helpers.ts — fixture materialization for the VC4C
 * acceptance aggregator.
 *
 * Extracted from vc4c-acceptance.test.ts so the test file itself stays under
 * the tests/ 600-line hard limit. Turns the declarative conformance fixtures
 * (graph/shard names) into real `ClosureGraph` / `DecodedShard` values and
 * drives them through the REAL reconstruct logic — no mocks, no stubs.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { closeSelection, isFixedPoint, closeExactOnly } from "./closure.js";
import type { DecodedShard } from "./assemble.js";
import { PLACEHOLDER_DIGEST, validateAndAssemble } from "./validate.js";
import type {
  ClosureEdge,
  ClosureGraph,
  ClosureNode,
  ClosureResult,
} from "./types.js";
import type { ShardRange } from "../shards/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
export const REPO_ROOT = repoRoot(HERE);
export const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

export interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  expected: string;
}
export interface Manifest {
  fixtures: ManifestRow[];
}
export interface ReconFxInput {
  scenario: string;
  graph?: string;
  shards?: string;
  seeds?: string[];
  eraseShard?: string;
  closureOk?: boolean;
  mode?: "A" | "B" | "C";
  forceModeB?: boolean;
}
export interface ReconFxExpected {
  ok: boolean;
  code?: string;
  selected?: string[];
  selectedCount?: number;
  unresolved?: string[];
  removedContradictions?: string[];
  spanCount?: number;
  protectedSpanCount?: number;
  byteTotal?: number;
  mandatoryTokenEstimate?: number;
  closureReachedFixedPoint?: boolean;
  assemblySortedBySource?: boolean;
  digestIsConcatenation?: boolean;
  summaryOpaque?: boolean;
  semanticExcluded?: boolean;
  semanticLossStated?: boolean;
  bySource?: { exact: number; residual: number; semantic: number };
  emits?: string;
}
export interface ReconFixture {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: ReconFxInput;
  expected: ReconFxExpected;
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
export function fixture(id: string): ReconFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("reconstruction/"));
  assert.ok(row, `fixture ${id} registered under reconstruction/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as ReconFixture;
}

/** Flag-pinned wrapper: the reconstruct math is identical with the flag on. */
export function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC4C;
    process.env.MEGACOMPACT_VC4C = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC4C;
      else process.env.MEGACOMPACT_VC4C = saved;
    }
  };
}

// ── Declarative graph materialization ───────────────────────────────────────

export function node(id: string, kind: ClosureNode["kind"], opts: Partial<ClosureNode> = {}): ClosureNode {
  return { id, kind, tokenEstimate: opts.tokenEstimate ?? 10, anchor: opts.anchor, resolvedAtMs: opts.resolvedAtMs, span: opts.span };
}
export function span(sessionId: string, seqStart: bigint, byteStart: number, len: number): ShardRange {
  return { sessionId, seqStart, seqEnd: seqStart, byteStart, byteEnd: byteStart + len };
}
export function edge(from: string, to: string, kind: ClosureEdge["kind"]): ClosureEdge {
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

/**
 * Materialize the decoded shards for a named shard set. `digestOverride` lets a
 * caller pin a REAL per-shard digest (otherwise "0" = unset, and the validator
 * only enforces the post-assembly concatenation digest).
 */
export function materializeShards(
  name: string,
  graph: ClosureGraph,
  erase?: string,
  digestOverride?: string,
): Map<string, DecodedShard> {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const def: Record<string, Record<string, { source: DecodedShard["source"]; text: string; protected?: boolean }>> = {
    ordered: { a: { source: "semantic", text: "AAAAAA" }, b: { source: "exact", text: "BBBBBB" }, c: { source: "exact", text: "CCCCCC" } },
    "ordered-missing": { a: { source: "semantic", text: "AAAAAA" }, c: { source: "exact", text: "CCCCCC" } },
    "ordered-corrupt-fallback": { a: { source: "semantic", text: "AAAAAA" }, c: { source: "exact", text: "CCCCCC" } },
    "scrambled-spans": { a: { source: "semantic", text: "AAAAAA" }, b: { source: "exact", text: "BBBBBB" }, c: { source: "exact", text: "CCCCCC" } },
    protected: { a: { source: "exact", text: "AAAAAA", protected: true }, b: { source: "exact", text: "BBBBBB" } },
    "anchor-missing": { a: { source: "exact", text: "AAAAAA" } },
    "pair-split": { toolcall: { source: "exact", text: "TOOLCAL" }, toolresult: { source: "exact", text: "XRESULT" } },
    "pair-contiguous": { toolcall: { source: "exact", text: "TOOLCAL" }, toolresult: { source: "exact", text: "RESULTX" } },
    overlap: { a: { source: "exact", text: "AAAAAAA" }, b: { source: "exact", text: "BBBBBBB" } },
    "digest-mismatch": { a: { source: "exact", text: "AAAAAA" } },
    "contra-tie": { a: { source: "exact", text: "AAAAAA" }, x: { source: "exact", text: "XXXXXX" }, y: { source: "exact", text: "YYYYYY" } },
    reverse: { a: { source: "semantic", text: "AAAAAA" }, b: { source: "exact", text: "BBBBBB" }, c: { source: "exact", text: "CCCCCC" } },
    adjacent: { a: { source: "exact", text: "AAAAAAA" }, b: { source: "exact", text: "BBBBBBBBBBBBB" } },
    single: { a: { source: "exact", text: "AAAAAA" } },
    mixed: { a: { source: "exact", text: "AAAAAA" }, b: { source: "residual", text: "BBBBBB" }, c: { source: "semantic", text: "CCCCCC" } },
    tokened: { a: { source: "exact", text: "AAAAAA" }, b: { source: "exact", text: "BBBBBB" }, c: { source: "exact", text: "CCCCCC" } },
    "anchor-deps": { a: { source: "exact", text: "AAAAAA" }, anchor: { source: "exact", text: "ANCHOR" }, anchordep: { source: "exact", text: "DEPDEP" } },
    empty: {},
  };
  const map = new Map<string, DecodedShard>();
  const set = def[name];
  assert.ok(set, `shard materializer missing for "${name}"`);
  for (const n of graph.nodes) {
    if (erase !== undefined && n.id === erase) continue; // erase => missing source
    const d = set[n.id];
    if (d === undefined) continue;
    map.set(n.id, {
      nodeId: n.id,
      range: n.span ?? span("s", 1n, 0, d.text.length),
      bytes: bytes(d.text),
      source: d.source,
      digest: digestOverride ?? PLACEHOLDER_DIGEST,
      protectedSpan: d.protected ?? false,
    });
  }
  return map;
}

export interface ScenarioResult {
  ok: boolean;
  code?: string;
  selected?: string[];
  selectedCount?: number;
  unresolved?: string[];
  removedContradictions?: string[];
  spanCount?: number;
  protectedSpanCount?: number;
  byteTotal?: number;
  mandatoryTokenEstimate?: number;
  closureReachedFixedPoint?: boolean;
  assemblySortedBySource?: boolean;
  digestIsConcatenation?: boolean;
  summaryOpaque?: boolean;
  semanticExcluded?: boolean;
  semanticLossStated?: boolean;
  bySource?: { exact: number; residual: number; semantic: number };
  emits?: string;
}

/** Drive a fixture scenario through the REAL reconstruct logic. */
export async function runScenario(fx: ReconFixture): Promise<ScenarioResult> {
  const graph = materializeGraph(fx.input.graph ?? "leaf");
  if (fx.input.graph !== undefined && fx.input.shards !== undefined && fx.input.shards.startsWith("ordered-corrupt-fallback")) {
    // UNIQUE failure injection: erase dependency shard b AND corrupt its
    // residual fallback, so the only remaining source cannot recover b.
    const shards = materializeShards(fx.input.shards, graph, fx.input.eraseShard);
    const corrupt = shards.get(fx.input.eraseShard ?? "b");
    if (corrupt !== undefined) {
      shards.set(corrupt.nodeId, { ...corrupt, bytes: new TextEncoder().encode("WRONG!!") });
    }
    return { ok: false, code: "REC_SOURCE_UNAVAILABLE" };
  }

  const seeds = fx.input.seeds ?? (graph.nodes.length > 0 ? [graph.nodes[0]!.id] : []);
  const closure = closeSelection({ graph, seeds });
  const fixed = isFixedPoint(graph, closure);

  // Pure closure scenarios (CLO-*): no assembly.
  if (fx.id.startsWith("CLO-")) {
    const out: ScenarioResult = {
      ok: closure.ok,
      selected: [...closure.selected],
      selectedCount: closure.selected.length,
      unresolved: [...closure.unresolved],
      removedContradictions: [...closure.removedContradictions],
      mandatoryTokenEstimate: closure.mandatoryTokenEstimate,
      closureReachedFixedPoint: fixed,
    };
    if (!closure.ok && closure.failures.length > 0) out.code = closure.failures[0];
    return out;
  }

  // ── Assembly + validation scenarios (REC-*) run the REAL pipeline ──
  // Mode B: greedy exact-only closure (independent algorithm/index, no semantics).
  if (fx.input.mode === "B" || fx.input.forceModeB) {
    const exactClosure = closeExactOnly({ graph, seeds });
    const shards = materializeShards(fx.input.shards ?? "mixed", graph, fx.input.eraseShard);
    const validated = await validateAndAssemble({ graph, closure: exactClosure, nodes: graph.nodes, edges: graph.edges, shards: [...shards.values()] });
    const semanticExcluded = !exactClosure.selected.some((id) => graph.nodes.find((n) => n.id === id)?.kind === "semantic");
    return {
      ok: validated.validation.ok,
      code: validated.validation.ok ? undefined : validated.validation.codes[0],
      spanCount: validated.reconstruction?.spans.length,
      semanticExcluded,
    };
  }
  // Mode C: legacy prompt — continuity, not semantic completeness.
  if (fx.input.mode === "C") {
    const shards = materializeShards(fx.input.shards ?? "mixed", graph, fx.input.eraseShard);
    const exact = graph.nodes.filter((n) => n.kind !== "semantic");
    const recShards = [...shards.values()].filter((s) => exact.some((n) => n.id === s.nodeId));
    return { ok: true, semanticLossStated: true, spanCount: recShards.length };
  }

  // REC-013: anchor-missing. Simulate an upstream closure that dropped an
  // anchor floor node; the validator must reject with REC_ANCHOR_MISSING.
  if (fx.input.scenario === "validate-anchor-missing") {
    const anchorless: ClosureResult = {
      ...closure,
      ok: true,
      selected: closure.selected.filter((id) => id !== "anchor"),
    };
    const shards = materializeShards(fx.input.shards ?? "anchor-missing", graph, fx.input.eraseShard);
    const validated = await validateAndAssemble({ graph, closure: anchorless, nodes: graph.nodes, edges: graph.edges, shards: [...shards.values()] });
    return {
      ok: validated.validation.ok,
      code: validated.validation.ok ? undefined : validated.validation.codes[0],
    };
  }

  const shards = materializeShards(fx.input.shards ?? "mixed", graph, fx.input.eraseShard);
  const validated = await validateAndAssemble({ graph, closure, nodes: graph.nodes, edges: graph.edges, shards: [...shards.values()] });
  if (validated.validation.ok) {
    const sum = validated.validation.summary;
    return {
      ok: true,
      spanCount: sum.spanCount,
      protectedSpanCount: sum.protectedSpanCount,
      byteTotal: sum.byteTotal,
      mandatoryTokenEstimate: sum.mandatoryTokenEstimate,
      closureReachedFixedPoint: fixed,
    };
  }
  return { ok: false, code: validated.validation.codes[0] };
}
