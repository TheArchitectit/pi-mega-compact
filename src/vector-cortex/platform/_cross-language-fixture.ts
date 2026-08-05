/**
 * platform/_cross-language-fixture.ts — VC8C cross-language fixture I/O.
 *
 * Reads conformance fixtures from the v2 `cross-language/` domain and decodes
 * them into the REAL production types (`ParityReportV1`, `EngineAbiV1`,
 * `NeutralRecord`) so `selectEngine` and the framing round-trip run against
 * the committed corpus — no mocks, no stubs.
 *
 * Mirrors `_diagnostics-fixture.ts` (VC7C) and `_adaptive-fixture.ts` (VC8B).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ParityReportV1 } from "./types.js";

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

const DIR = join(repoRoot(here), "conformance", "vector-cortex", "v2", "cross-language");

/** Read + parse one cross-language conformance fixture by ID. */
export function crossLanguageFixture(id: string): Record<string, unknown> {
  const raw = readFileSync(join(DIR, `${id}.json`), "utf8");
  return JSON.parse(raw);
}

// ── Cross-language golden / error fixture shape ───────────────────────────────

interface CrossLangFx {
  id: string;
  fixtureId: string;
  kind: string;
  assertion: string;
  inputHex: string;
  expected: { ok: boolean; code?: string };
  expectedFailureCode: string | null;
  expectedOutputHex: string;
}

/** Read a numbered or named cross-language fixture as a typed CrossLangFx. */
export function xlangFx(id: string): CrossLangFx {
  return crossLanguageFixture(id) as unknown as CrossLangFx;
}

/** Build a ParityReportV1 whose matrix has exactly one failing row at `badIndex`. */
export function reportWithMatrixFailure(
  badIndex: number,
  code: string,
  digest: string,
  platform: string,
): ParityReportV1 {
  const matrix = Array.from({ length: 30 }, (_, i) => ({
    fixtureId: `RUST-${String(i + 1).padStart(3, "0")}`,
    ok: i === badIndex ? false : true,
    code: i === badIndex ? code : null,
  }));
  return {
    schema: "parity-report-v1",
    artifactUrl: "file:///local/rad",
    commit: "0".repeat(40),
    cargoLockDigest: "a".repeat(64),
    artifactCargoLockDigest: digest,
    platform,
    matrix,
  };
}

/** Build a fully-qualified ParityReportV1 (all matrix rows ok). */
export function okReport(digest: string, platform: string): ParityReportV1 {
  return reportWithMatrixFailure(-1, "", digest, platform);
}
