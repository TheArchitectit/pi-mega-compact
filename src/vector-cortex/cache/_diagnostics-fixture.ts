/**
 * cache/_diagnostics-fixture.ts — VC7C conformance fixture I/O + host builders.
 *
 * Reads conformance fixtures from the v2 `cache-diagnostics/` domain, decodes
 * them into the REAL production types (`MissObservation`, `M5Host`) and feeds
 * them verbatim into `classifyMiss` / `migrateRequestHashV2`. Fixtures store
 * bigints as JSON numbers — converted here (lossy conversion would break
 * digests and the acceptance rows would fail loudly).
 *
 * No mocks, no stubs, no parallel "test shape": the decoded objects ARE
 * `MissObservation` / `M5Host` and drive the production functions directly.
 * Mirrors `_economics-fixture.ts`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { MissObservation } from "./diagnostics-types.js";
import type {
  M5Host,
  RequestHashV1Row,
  RequestHashV2Row,
} from "../migrations/request-hash-v2-types.js";

const here = dirname(fileURLToPath(import.meta.url));

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

const V2 = join(repoRoot(here), "conformance", "vector-cortex", "v2");
const DIR = join(V2, "cache-diagnostics");

/** Read + parse one conformance fixture by ID. */
export function diagnosticsFixture(id: string): Record<string, unknown> {
  const raw = readFileSync(join(DIR, `${id}.json`), "utf8");
  return JSON.parse(raw);
}

/** Run `fn` with MEGACOMPACT_VC7C set to `value`, restoring the prior value after. */
export function withVc7cFlag<T>(value: string, fn: () => T): T {
  const prior = process.env.MEGACOMPACT_VC7C;
  process.env.MEGACOMPACT_VC7C = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.MEGACOMPACT_VC7C;
    else process.env.MEGACOMPACT_VC7C = prior;
  }
}

// ── Cache-diagnostic fixture types (CACHE-016..030 + named) ──────────────────

interface CacheFxInput {
  scenario: string;
  observe: {
    requestProfileId: string;
    requestProfileVersion: string;
    cachedProfileId: string | null;
    cachedProfileVersion: string | null;
    requestCoveredDigest: string;
    cachedCoveredDigest: string | null;
    requestedRangeCount: number;
    cachedRangeCount: number | null;
    requestDigest: string;
    cachedRequestDigest: string | null;
    requestDependencyHighWater: number;
    cachedDependencyHighWater: number | null;
    generationInvalidated: boolean;
  };
}

interface CacheFxExpected {
  ok: boolean;
  missClass: string;
  evidence: {
    profileMismatch: boolean;
    rangeMismatch: boolean;
    dependencyAdvanced: boolean;
    requestMismatch: boolean;
    generationInvalidated: boolean;
    requestedRangeCount: number;
    cachedRangeCount: number;
    dependencyDelta: number;
    absent: boolean;
  };
}

export interface CacheFx {
  id: string;
  assertion: string;
  input: CacheFxInput;
  expected: CacheFxExpected;
}

/** Read a cache-diagnostic fixture as a typed CacheFx. */
export function cacheFx(id: string): CacheFx {
  return diagnosticsFixture(id) as unknown as CacheFx;
}

/** Decode the fixture's JSON observe into the production MissObservation. */
export function toObservation(fx: CacheFx): MissObservation {
  const o = fx.input.observe;
  return {
    requestProfileId: o.requestProfileId,
    requestProfileVersion: o.requestProfileVersion,
    cachedProfileId: o.cachedProfileId,
    cachedProfileVersion: o.cachedProfileVersion,
    requestCoveredDigest: o.requestCoveredDigest,
    cachedCoveredDigest: o.cachedCoveredDigest,
    requestedRangeCount: o.requestedRangeCount,
    cachedRangeCount: o.cachedRangeCount,
    requestDigest: o.requestDigest,
    cachedRequestDigest: o.cachedRequestDigest,
    requestDependencyHighWater: BigInt(o.requestDependencyHighWater),
    cachedDependencyHighWater:
      o.cachedDependencyHighWater === null
        ? null
        : BigInt(o.cachedDependencyHighWater),
    generationInvalidated: o.generationInvalidated,
  };
}

// ── M5 fixture types (M5-001..020 + M5-COLLIDE-002) ─────────────────────────

interface M5FxInput {
  scenario: string;
  v1Rows: readonly { profileId: string; requestDigest: string; hash: string }[];
  econVersionOf: Record<string, string>;
  activeVersion: number;
  sessionOf: Record<string, string>;
  liveGenerationOf: Record<string, number>;
}

interface M5FxExpected {
  ok: boolean;
  codes: string[];
  activeVersionAfter: number;
}

export interface M5Fx {
  id: string;
  assertion: string;
  input: M5FxInput;
  expected: M5FxExpected;
}

/** Read an M5 fixture as a typed M5Fx. */
export function m5Fx(id: string): M5Fx {
  return diagnosticsFixture(id) as unknown as M5Fx;
}

/** Build an in-memory M5Host from the fixture input. */
export function toM5Host(
  fx: M5Fx,
): M5Host & { activeVersionAfter: number } {
  const v1Rows: RequestHashV1Row[] = fx.input.v1Rows.map((r) => ({
    profileId: r.profileId,
    requestDigest: r.requestDigest,
    hash: r.hash,
  }));
  const v2Rows: RequestHashV2Row[] = [];
  let activeVersion = fx.input.activeVersion;

  const host: M5Host & { activeVersionAfter: number } = {
    v1Rows: () => v1Rows,
    economicsVersionOf: (p) => fx.input.econVersionOf[p] ?? "econ-1",
    sessionOf: (p) => fx.input.sessionOf[p] ?? "s1",
    liveGenerationOf: (s) =>
      BigInt(fx.input.liveGenerationOf[s] ?? 0),
    existingV2: () => v2Rows,
    putV2: (rows) => v2Rows.push(...rows),
    activeVersion: () => activeVersion,
    switchToV2: () => {
      activeVersion = 2;
    },
    get activeVersionAfter() {
      return activeVersion;
    },
  };
  return host;
}
