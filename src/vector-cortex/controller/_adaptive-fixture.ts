/**
 * controller/_adaptive-fixture.ts — VC8B conformance fixture I/O + host builders.
 *
 * Reads conformance fixtures from the v2 `adaptive-policy/` domain, decodes
 * them into the REAL production types (`PolicyInput`, `M7Host`) and feeds
 * them verbatim into `evaluatePolicy` / `evaluateShadow` / `migratePressureV2`.
 *
 * No mocks, no stubs, no parallel "test shape": the decoded objects ARE the
 * production types and drive the production functions directly.
 * Mirrors `_diagnostics-fixture.ts` (VC7C) and `_economics-fixture.ts` (VC7B).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PolicyInput } from "./types.js";
import type {
  M7Host,
  PressureV1Row,
  PressureV2Row,
} from "../migrations/pressure-v2-types.js";

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
const DIR = join(V2, "adaptive-policy");

/** Read + parse one conformance fixture by ID from adaptive-policy/. */
export function adaptiveFixture(id: string): Record<string, unknown> {
  const raw = readFileSync(join(DIR, `${id}.json`), "utf8");
  return JSON.parse(raw);
}

/** Run `fn` with MEGACOMPACT_VC8B set to `value`, restoring the prior value after. */
export function withVc8bFlag<T>(value: string, fn: () => T): T {
  const prior = process.env.MEGACOMPACT_VC8B;
  process.env.MEGACOMPACT_VC8B = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.MEGACOMPACT_VC8B;
    else process.env.MEGACOMPACT_VC8B = prior;
  }
}

// ── Policy decision fixtures (POL-001..025 + POL-CLAMP-001) ──────────────────

interface PolFxInput {
  decisionId: string;
  sessionId: string;
  pressure: string;
  requestedBudget: number;
  bounds: { minBudget: number; maxBudget: number };
  ts: string;
  alternateRequestedBudget?: number;
}

interface PolFxExpected {
  ok: boolean;
  action?: string;
  budget?: number;
  pressure?: string;
  reason?: string;
  code?: string;
  alternateBudget?: number;
  alternateReason?: string;
}

export interface PolFx {
  id: string;
  assertion: string;
  input: PolFxInput;
  expected: PolFxExpected;
}

/** Read a policy-decision fixture as a typed PolFx. */
export function polFx(id: string): PolFx {
  return adaptiveFixture(id) as unknown as PolFx;
}

/** Decode the fixture's JSON input into the production PolicyInput. */
export function toPolicyInput(fx: PolFx): PolicyInput {
  return {
    decisionId: fx.input.decisionId,
    sessionId: fx.input.sessionId,
    pressure: fx.input.pressure,
    requestedBudget: fx.input.requestedBudget,
    bounds: {
      minBudget: fx.input.bounds.minBudget,
      maxBudget: fx.input.bounds.maxBudget,
    },
    ts: fx.input.ts,
  };
}

// ── Shadow fixtures (POL-SHADOW-002) ────────────────────────────────────────

interface ShadowFxInput {
  inputs: readonly PolFxInput[];
  promptBytes: string;
}

interface ShadowFxExpected {
  ok: boolean;
  evaluated?: number;
  clamped?: number;
  rejected?: number;
  liveMutations?: number;
  promptUnchanged?: boolean;
}

export interface ShadowFx {
  id: string;
  assertion: string;
  input: ShadowFxInput;
  expected: ShadowFxExpected;
}

/** Read a policy-shadow fixture as a typed ShadowFx. */
export function shadowFx(id: string): ShadowFx {
  return adaptiveFixture(id) as unknown as ShadowFx;
}

/** Decode shadow input rows into production PolicyInput[]. */
export function toShadowInputs(fx: ShadowFx): readonly PolicyInput[] {
  return fx.input.inputs.map((i) => ({
    decisionId: i.decisionId,
    sessionId: i.sessionId,
    pressure: i.pressure,
    requestedBudget: i.requestedBudget,
    bounds: {
      minBudget: i.bounds.minBudget,
      maxBudget: i.bounds.maxBudget,
    },
    ts: i.ts,
  }));
}

// ── M7 pressure-v2 fixtures (M7-001..015 + M7-PRESSURE-003) ─────────────────

interface M7FxInput {
  scenario: string;
  v1Rows: readonly {
    sessionId: string;
    label: string;
    effectiveSeq: number;
    ts: string;
  }[];
  injectedRow?: {
    sessionId: string;
    label: string;
    effectiveSeq: number;
    ts: string;
  };
  activeVersion?: number;
}

interface M7FxExpected {
  ok: boolean;
  codes?: string[];
  code?: string;
  activeVersionAfter?: number;
  rowCount?: number;
}

export interface M7Fx {
  id: string;
  assertion: string;
  input: M7FxInput;
  expected: M7FxExpected;
}

/** Read an M7 fixture as a typed M7Fx. */
export function m7Fx(id: string): M7Fx {
  return adaptiveFixture(id) as unknown as M7Fx;
}

/** Build an in-memory M7Host from the fixture input. */
export function toM7Host(
  fx: M7Fx,
): M7Host & { activeVersionAfter: number; readonly v2RowCount: number } {
  const v1Rows: PressureV1Row[] = fx.input.v1Rows.map((r) => ({
    sessionId: r.sessionId,
    label: r.label,
    effectiveSeq: r.effectiveSeq,
    ts: r.ts,
  }));
  // For inject-after-copy, the injected row carries a non-canonical label.
  // migratePressureV2 calls m7Copy first, which throws M7_PRESSURE_UNKNOWN for
  // the bad label — the result is the same: ok:false, pointer on v1.
  if (fx.input.injectedRow) {
    v1Rows.push({
      sessionId: fx.input.injectedRow.sessionId,
      label: fx.input.injectedRow.label,
      effectiveSeq: fx.input.injectedRow.effectiveSeq,
      ts: fx.input.injectedRow.ts,
    });
  }
  const v2Rows: PressureV2Row[] = [];
  let activeVersion = fx.input.activeVersion ?? 1;

  const host: M7Host & { activeVersionAfter: number; readonly v2RowCount: number } = {
    v1Rows: () => v1Rows,
    existingV2: () => v2Rows,
    putV2: (rows) => v2Rows.push(...rows),
    activeVersion: () => activeVersion,
    switchToV2: () => {
      activeVersion = 2;
    },
    get activeVersionAfter() {
      return activeVersion;
    },
    get v2RowCount() {
      return v2Rows.length;
    },
  };
  return host;
}
