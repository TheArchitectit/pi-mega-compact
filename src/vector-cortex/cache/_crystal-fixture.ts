/**
 * cache/_crystal-fixture.ts — conformance fixture I/O for VC7A crystal rows.
 *
 * Sibling of `../heal/_restore-fixture.ts`, same job for a different corpus:
 * turn canonical JSON back into the REAL production types the cache modules
 * consume. Fixtures cannot express bigints, so `dependencyHighWater` and the
 * span seq bounds are stored as numbers and converted here — if that conversion
 * were lossy the encoded keys would diverge and the acceptance rows would fail
 * loudly, which is exactly the guarantee an identity sprint needs.
 *
 * No mocks, no stubs, no parallel "test shape": the decoded objects ARE
 * `CrystalKeyV1` / `DagSpan` and are fed verbatim into `encodeCrystalKey` and
 * `CrystalStore`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import type { CrystalKeyV1, DagSpan } from "./types.js";
import { computeCoveredDigest } from "./crystal.js";
import { V2, readManifest } from "../heal/_acceptance-fixture.js";

/** A `DagSpan` as it appears in JSON: seq bounds are numbers, not bigints. */
export interface CrystalFxSpan {
  sessionId: string;
  startSeq: number;
  endSeq: number;
  startByte: number;
  endByte: number;
  digest: string;
}

export interface CrystalFxKey {
  profileId: string;
  profileVersion: string;
  requestDigest: string;
  rendererVersion: string;
  dependencyHighWater: number;
  sourceRanges: CrystalFxSpan[];
}

export interface CrystalFxInput {
  scenario: "key" | "compare" | "store";
  mode: string;
  key: CrystalFxKey;
  other?: CrystalFxKey;
  unrelatedAppend?: CrystalFxSpan;
  bytes?: string;
  secondBytes?: string;
}

export interface CrystalFxExpected {
  ok: boolean;
  code?: string;
  sameKey?: boolean;
  written?: boolean;
  crystalCount?: number;
  rangeCount?: number;
  sortedSessions?: string[];
  sortedStartBytes?: number[];
  mode?: "A" | "B" | "C";
}

export interface CrystalFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: CrystalFxInput;
  expected: CrystalFxExpected;
}

/** Read one registered cache-crystal fixture (asserting it IS registered). */
export function crystalFixture(id: string): CrystalFx {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("cache-crystals/"));
  assert.ok(row, `fixture ${id} registered under cache-crystals/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as CrystalFx;
}

/** JSON number seq bounds -> the bigint bounds `DagSpan` declares. */
export function decodeSpan(s: CrystalFxSpan): DagSpan {
  return {
    sessionId: s.sessionId,
    startSeq: BigInt(s.startSeq),
    endSeq: BigInt(s.endSeq),
    startByte: s.startByte,
    endByte: s.endByte,
    digest: s.digest as DagSpan["digest"],
  };
}

/**
 * Reconstitute a real `CrystalKeyV1`. `coveredDigest` is DERIVED from the ranges
 * rather than carried in the corpus: the covered digest is a function of the
 * ranges, so storing it would let a fixture assert a self-inconsistent identity
 * that the encoder would silently re-derive anyway.
 */
export function decodeKey(k: CrystalFxKey): CrystalKeyV1 {
  const sourceRanges = k.sourceRanges.map(decodeSpan);
  return {
    profileId: k.profileId,
    profileVersion: k.profileVersion,
    requestDigest: k.requestDigest,
    rendererVersion: k.rendererVersion,
    dependencyHighWater: BigInt(k.dependencyHighWater),
    sourceRanges,
    coveredDigest: computeCoveredDigest(sourceRanges),
  };
}

/** Flag-pinned wrapper: VC7A gated by MEGACOMPACT_VC7A (defaults ON). */
export function withVc7aFlag(value: string, fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC7A;
    process.env.MEGACOMPACT_VC7A = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC7A;
      else process.env.MEGACOMPACT_VC7A = saved;
    }
  };
}
