/**
 * heal/_repair-fixture.ts — conformance fixture I/O for VC6C healing-controller rows.
 *
 * Sibling of `_restore-fixture.ts` (VC6B) and `_acceptance-fixture.ts` (VC6A);
 * split out so no loader approaches the 300-line soft limit and so the
 * BigInt/base64 decoding lives next to the contract it reconstitutes.
 *
 * DECODING IS THE POINT. Fixtures are canonical JSON, which cannot express
 * bigints or bytes, so the corpus stores numeric `nowMs` / high-waters and
 * base64 source bytes. These loaders turn those back into the REAL `RepairState`
 * / `RebuildInput` objects the production controller consumes — no mocks, no
 * stubs, no parallel "test shape". A lossy decode would make the digests or the
 * planned ranges disagree and the acceptance test would fail loudly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import type { Mode, RepairState } from "./repair-types.js";
import type { RebuildInput } from "./rebuild.js";
import { V2, readManifest } from "./_acceptance-fixture.js";

/** A subsystem state as it appears in JSON: high-waters are numbers, not bigints. */
export interface RepairFxState {
  subsystem: string;
  derivedHighWater: number;
  authorityHighWater: number;
  lastRebuildAt: number | null;
  generation: number;
  mode: Mode;
  failedAttempts?: number;
  authorityFrozen?: boolean;
}

export interface RepairFxRebuild {
  subsystem: string;
  generation: number;
  currentGeneration: number;
  sourceBytesBase64: string;
  expectedDigest: string;
  triadMode: Mode;
}

export interface RepairFxBackoff {
  subsystem: string;
  attempts: number[];
}

export interface RepairFxInput {
  scenario: string;
  /** Which real entry point the acceptance test drives. */
  mode: "detect" | "backoff" | "rebuild";
  /** The INJECTED monotonic clock — VC6C never reads a real clock. */
  nowMs: number;
  states: RepairFxState[];
  rebuild?: RepairFxRebuild;
  backoff?: RepairFxBackoff;
}

export interface RepairFxExpected {
  ok: boolean;
  code?: string;
  plannedCount: number;
  /** Exact [seqStart, seqEnd] of each plan, in plan order. */
  ranges: number[][];
  switched?: boolean;
  generation?: number;
  semanticLossStated?: boolean;
  monotonic?: boolean;
  capped?: boolean;
  idempotent?: boolean;
}

export interface RepairFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: RepairFxInput;
  expected: RepairFxExpected;
}

/** Read one registered healing-controller fixture (asserting it IS registered). */
export function repairFixture(id: string): RepairFx {
  const m = readManifest();
  const row = m.fixtures.find(
    (f) => f.id === id && f.path.startsWith("healing-controller/"),
  );
  assert.ok(row, `fixture ${id} registered under healing-controller/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as RepairFx;
}

/** JSON numbers -> the bigint fields `RepairState` declares. */
export function decodeState(s: RepairFxState): RepairState {
  return {
    subsystem: s.subsystem,
    derivedHighWater: BigInt(s.derivedHighWater),
    authorityHighWater: BigInt(s.authorityHighWater),
    lastRebuildAt: s.lastRebuildAt === null ? null : BigInt(s.lastRebuildAt),
    generation: s.generation,
    mode: s.mode,
    ...(s.failedAttempts !== undefined ? { failedAttempts: s.failedAttempts } : {}),
    ...(s.authorityFrozen !== undefined ? { authorityFrozen: s.authorityFrozen } : {}),
  };
}

/** Reconstitute a real `RebuildInput` from its fixture row. */
export function decodeRebuild(r: RepairFxRebuild): RebuildInput {
  return {
    subsystem: r.subsystem,
    range: {
      sessionId: r.subsystem,
      seqStart: 0n,
      seqEnd: 0n,
      byteStart: 0,
      byteEnd: 0,
    },
    generation: r.generation,
    sourceBytes: new Uint8Array(Buffer.from(r.sourceBytesBase64, "base64")),
    expectedDigest: r.expectedDigest,
  };
}

/** Flag-pinned wrapper: VC6C gated by MEGACOMPACT_VC6C (defaults ON). */
export function withVc6cFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC6C;
    process.env.MEGACOMPACT_VC6C = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6C;
      else process.env.MEGACOMPACT_VC6C = saved;
    }
  };
}
