/**
 * cache/_economics-fixture.ts — conformance fixture I/O for VC7B economics rows.
 *
 * Sibling of `./_crystal-fixture.ts`, same job for a different corpus: turn
 * canonical JSON back into the REAL production types the economics / compiler /
 * experiments modules consume. Fixtures cannot express bigints, so token counts
 * stored as numbers are converted here — if that conversion were lossy the
 * computed digests would diverge and the acceptance rows would fail loudly.
 *
 * No mocks, no stubs, no parallel "test shape": the decoded objects ARE
 * `ProviderEconomicsV1` / `CacheUsageV1` / `CacheExperimentV1` and are fed
 * verbatim into `validateProfileEconomics`, `computeEconomics`, `compileCrystalBoundaries`,
 * and `assignExperiment`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import { V2, readManifest } from "../heal/_acceptance-fixture.js";

/** A `ProviderProfileExclusion` as it appears in JSON. */
export interface EconFxExclusion {
  pointer: string;
  fixtureId: string;
  proofDigest: string;
}

/** A `ProviderProfileV1` as it appears in JSON (exclusions flattened). */
export interface EconFxProfile {
  profileId: string;
  profileVersion: string;
  exclusionFixtureId: string | null;
  exclusions: readonly EconFxExclusion[];
}

/** A `CacheUsageV1` as it appears in JSON (matches `CacheUsageV1` exactly). */
export interface EconFxUsage {
  cachedTokens: number;
  writeCount: number;
  hitCount: number;
}

/** A compiler input range as it appears in JSON (matches `DagSpan` minus seq). */
export interface EconFxCompilerRange {
  sessionId: string;
  startSeq: number;
  endSeq: number;
  startByte: number;
  endByte: number;
  digest: string;
}

export interface EconFxExperiment {
  experimentId: string;
  sessionId: string;
  arm: "A" | "B" | "C";
  source: "randomized" | "forced" | "shadow";
}

export interface EconFxInput {
  scenario: "economics" | "exclusion" | "compile" | "experiment" | "eligibility";
  mode: string;
  economics?: ProviderEconomicsV1Lite;
  profile?: EconFxProfile;
  exclusion?: EconFxExclusion;
  usage?: EconFxUsage;
  prefixTokens?: number;
  ageMs?: number;
  ranges?: readonly EconFxCompilerRange[];
  experiment?: EconFxExperiment;
  repeatAssignments?: number;
  loseJournalAfterFirst?: boolean;
}

export interface ProviderEconomicsV1Lite {
  profileId: string;
  profileVersion: string;
  basePrice: number;
  readPrice: number;
  writePrice: number;
  ttlMs: number;
  minPrefix: number;
  exclusionFixtureId: string | null;
}

export interface EconFxExpected {
  ok: boolean;
  code?: string;
  netSavings?: number;
  tokenSavings?: number;
  breakEvenHits?: number | null;
  eligible?: boolean;
  identityPreserved?: boolean;
  repeatArm?: "A" | "B" | "C";
}

export interface EconFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: EconFxInput;
  expected: EconFxExpected;
}

/** Read one registered cache-economics fixture (asserting it IS registered). */
export function economicsFixture(id: string): EconFx {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("cache-economics/"));
  assert.ok(row, `fixture ${id} registered under cache-economics/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as EconFx;
}

/** Flag-pinned wrapper: VC7B gated by MEGACOMPACT_VC7B (defaults ON). */
export function withVc7bFlag(value: string, fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC7B;
    process.env.MEGACOMPACT_VC7B = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC7B;
      else process.env.MEGACOMPACT_VC7B = saved;
    }
  };
}
