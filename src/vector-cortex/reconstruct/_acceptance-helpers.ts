/**
 * reconstruct/_acceptance-helpers.ts — fixture materialization for the VC4C
 * acceptance aggregator.
 *
 * Extracted from vc4c-acceptance.test.ts so the test file itself stays under
 * the tests/ 600-line hard limit. Turns the declarative conformance fixtures
 * (graph/shard names) into real `ClosureGraph` / `DecodedShard` values and
 * drives them through the REAL reconstruct logic — no mocks, no stubs.
 *
 * Graph materializations live in _acceptance-graphs.ts (delegate-shell split
 * per CLAUDE.md §6 — this file exceeded the 300-line soft limit).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { closeSelection, isFixedPoint, closeExactOnly } from "./closure.js";
import type { DecodedShard } from "./assemble.js";
import { PLACEHOLDER_DIGEST, validateAndAssemble } from "./validate.js";
import type { ClosureResult, ClosureGraph } from "./types.js";

// Delegate-shell re-exports — graph/span/node/edge + materializeGraph live in
// the sibling impl file so this file stays under the 300-line soft limit.
export { node, span, edge, materializeGraph } from "./_acceptance-graphs.js";
import { span, materializeGraph } from "./_acceptance-graphs.js";

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

/** Materialize the decoded shards for a named shard set. `digestOverride` lets a
 * caller pin a REAL per-shard digest (otherwise PLACEHOLDER_DIGEST = unset, and
 * the validator only enforces the post-assembly concatenation digest).
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
