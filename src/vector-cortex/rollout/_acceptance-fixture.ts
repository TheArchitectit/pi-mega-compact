/**
 * rollout/_acceptance-fixture.ts — conformance fixture I/O for VC5C rollout
 * acceptance rows.
 *
 * Reads the v2 conformance manifest + the per-sprint rollout fixture files, and
 * exposes the `RolloutFx` shape the acceptance aggregator drives. No
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

function readFixture(id: string, prefix: "rollout"): unknown {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith(`${prefix}/`));
  assert.ok(row, `fixture ${id} registered under ${prefix}/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8"));
}

export interface RolloutFxEvidence {
  windowStartMs?: number;
  powered?: boolean;
  events?: number;
  sessions?: number;
  hardFaults?: Array<{ kind: string; detail: string }>;
}
export interface RolloutFxInput {
  scenario: string;
  sessionId?: string;
  evidence?: RolloutFxEvidence;
}
export interface RolloutFxExpected {
  ok: boolean;
  bucket?: number;
  gateIndex?: number;
  promotionBlocked?: boolean;
  selectsPreVc?: boolean;
}
export interface RolloutFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: RolloutFxInput;
  expected: RolloutFxExpected;
}
export function rolloutFixture(id: string): RolloutFx {
  return readFixture(id, "rollout") as RolloutFx;
}

/** Flag-pinned wrapper: VC5C gated by MEGACOMPACT_VC5C (defaults ON). */
export function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC5C;
    process.env.MEGACOMPACT_VC5C = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC5C;
      else process.env.MEGACOMPACT_VC5C = saved;
    }
  };
}
