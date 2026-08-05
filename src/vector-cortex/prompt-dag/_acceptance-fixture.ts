/**
 * prompt-dag/_acceptance-fixture.ts — conformance fixture I/O for VC5A DAG +
 * planner acceptance rows.
 *
 * Reads the v2 conformance manifest + the per-sprint fixture files, and exposes
 * the `DagFixture` / `PlnFixture` shapes the acceptance aggregator drives. No
 * mocks/stubs: the fixtures are the committed canonical corpus.
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
export interface Manifest {
  fixtures: ManifestRow[];
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}

/** Resolve a fixture row by ID, restricting to one of this sprint's two roots. */
function readFixture(id: string, prefix: "prompt-dag" | "planner"): unknown {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith(`${prefix}/`));
  assert.ok(row, `fixture ${id} registered under ${prefix}/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8"));
}

// ── DAG fixture shape ──
export interface DagFxInput {
  scenario: string;
  graph?: string;
  permute?: boolean;
  mutateDigest?: boolean;
}
export interface DagFxExpected {
  ok: boolean;
  code?: string;
  order?: string[];
  orderLength?: number;
  permutationInvariant?: boolean;
  digestStable?: boolean;
  digestSensitive?: boolean;
  orderIsTotal?: boolean;
}
export interface DagFixture {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: DagFxInput;
  expected: DagFxExpected;
}
export function dagFixture(id: string): DagFixture {
  return readFixture(id, "prompt-dag") as DagFixture;
}

// ── Planner fixture shape ──
export interface PlnFxInput {
  scenario: string;
  candidates: string;
  tokenBudget: number;
  zeroFraming?: boolean;
  permute?: boolean;
  mutateTokensAfterPlan?: boolean;
}
export interface PlnFxExpected {
  ok: boolean;
  code?: string;
  selected?: string[];
  tokenTotal?: number;
  firstSelected?: string;
  mandatoryPreserved?: boolean;
  demotesToC?: boolean;
  omittedOverBudget?: boolean;
  omittedZeroUtility?: boolean;
  omittedIncompatible?: boolean;
  noPartialSelection?: boolean;
  withinBudget?: boolean;
  planIsClosed?: boolean;
  permutationInvariant?: boolean;
  manifestStable?: boolean;
}
export interface PlnFixture {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: PlnFxInput;
  expected: PlnFxExpected;
}
export function plnFixture(id: string): PlnFixture {
  return readFixture(id, "planner") as PlnFixture;
}

/** Flag-pinned wrapper: VC5A gated by MEGACOMPACT_VC5A (defaults ON). */
export function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC5A;
    process.env.MEGACOMPACT_VC5A = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC5A;
      else process.env.MEGACOMPACT_VC5A = saved;
    }
  };
}
