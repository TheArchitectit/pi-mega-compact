/**
 * render/_acceptance-fixture.ts — conformance fixture I/O for VC5B render +
 * provider acceptance rows.
 *
 * Reads the v2 conformance manifest + the per-sprint fixture files, and exposes
 * the `RenderFx` / `ProviderFx` shapes the acceptance aggregator drives. No
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

function readFixture(id: string, prefix: "render" | "provider"): unknown {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith(`${prefix}/`));
  assert.ok(row, `fixture ${id} registered under ${prefix}/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8"));
}

export interface RenderFxInput {
  scenario: string;
  graph: string;
  profile: string;
  mutateByteAfterRender?: boolean;
  swapProfileAfterRender?: boolean;
}
export interface RenderFxExpected {
  ok: boolean;
  code?: string;
  nodeOrder?: string[];
  orderReplay?: boolean;
  permutationInvariant?: boolean;
  toolBytesExact?: boolean;
  invalidUtf8Survives?: boolean;
  requestDigestStable?: boolean;
  requestDigestSensitive?: boolean;
  digestOrderIndependent?: boolean;
  hashModeEntire?: boolean;
  bypassClean?: boolean;
  profileResolved?: boolean;
  selectsTriadC?: boolean;
  usesHostPrependSeam?: boolean;
  forbidsSystemRole?: boolean;
}
export interface RenderFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: RenderFxInput;
  expected: RenderFxExpected;
}
export function renderFixture(id: string): RenderFx {
  return readFixture(id, "render") as RenderFx;
}

export interface ProviderFxInput {
  scenario: string;
  provider: string;
  model: string;
}
export interface ProviderFxExpected {
  ok: boolean;
  code?: string;
  profileId?: string;
  hashMode?: string;
  excludedPointers?: string[];
  bypassClean?: boolean;
  cacheStable?: boolean;
  deterministic?: boolean;
}
export interface ProviderFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: ProviderFxInput;
  expected: ProviderFxExpected;
}
export function providerFixture(id: string): ProviderFx {
  return readFixture(id, "provider") as ProviderFx;
}

/** Flag-pinned wrapper: VC5B gated by MEGACOMPACT_VC5B (defaults ON). */
export function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC5B;
    process.env.MEGACOMPACT_VC5B = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC5B;
      else process.env.MEGACOMPACT_VC5B = saved;
    }
  };
}
