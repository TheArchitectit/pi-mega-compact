/**
 * heal/_acceptance-fixture.ts — conformance fixture I/O for VC6A closure
 * optimization acceptance rows.
 *
 * Reads the v2 conformance manifest + the per-sprint closure-optimization
 * fixture files, and exposes the `HealFx` shape the acceptance aggregator
 * drives. No mocks/stubs: the fixtures are the committed canonical corpus, fed
 * verbatim into `closeSelection` → `optimizeClosure` → `verifyProof`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

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
export const REPO_ROOT = repoRoot(HERE);
export const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

export interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  expected: string;
}

export interface HealFxGraphNode {
  id: string;
  kind: string;
  tokenEstimate: number;
  anchor?: boolean;
}
export interface HealFxGraphEdge {
  from: string;
  to: string;
  kind: "depends" | "tool-pair" | "contradicts";
}
export interface HealFxGraph {
  sessionId: string;
  nodes: HealFxGraphNode[];
  edges: HealFxGraphEdge[];
  resolutions?: Array<{ loserId: string; winnerId: string }>;
}
export interface HealFxInput {
  graph: HealFxGraph;
  scenario: string;
  seeds: string[];
}
export interface HealFxExpected {
  ok: boolean;
  code?: string;
  removedEdges: number;
  retainedEdges: number;
  selectedMatch: boolean;
  protectedRetained: number;
  deterministic?: boolean;
}
export interface HealFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: HealFxInput;
  expected: HealFxExpected;
}

export function readManifest(): { fixtures: ManifestRow[] } {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as {
    fixtures: ManifestRow[];
  };
}

function readFixture(id: string, prefix: "closure-optimization"): HealFx {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith(`${prefix}/`));
  assert.ok(row, `fixture ${id} registered under ${prefix}/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as HealFx;
}

export function healFixture(id: string): HealFx {
  return readFixture(id, "closure-optimization");
}

/** Flag-pinned wrapper: VC6A gated by MEGACOMPACT_VC6A (defaults ON). */
export function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC6A;
    process.env.MEGACOMPACT_VC6A = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6A;
      else process.env.MEGACOMPACT_VC6A = saved;
    }
  };
}
