/**
 * vector-cortex/migrations/occurrence-v2.ts — M2 copy/validate/switch migration
 * for the occurrence-v2 ledger + compat journal (VC1B).
 *
 * M2 converts the neutral v2 ledger into a lossless legacy export so an OLD
 * binary may keep reading after a downgrade. It follows the compat-journal
 * copy/validate/switch contract: COPY the v2 rows + journal records into the
 * staged legacy export, VALIDATE the staged export (seq monotonicity + digest
 * parity + unrepresentable rows listed), and ONLY THEN atomically SWITCH
 * authority to the export. Each phase is exposed separately so a crash between
 * validate and switch retains the OLD authority and a restart resumes
 * idempotently (the unique failure-injection contract — terminate after
 * `validated` and before `switched`, restart switches once without duplicate
 * rows).
 *
 * Runs against an injected M2Host so the migration is deterministic and
 * testable. Never mutates v2; the export is a NEW copy (silent direct downgrade
 * is rejected). Registered conformance rows: M2-001..015 + MIG-DOWN-001.
 * PREVENT-002/011/PI-004 honored; no console.log.
 */

import type { DatabaseSync } from "node:sqlite";
import { MIG_DOWN_FAIL, verifyLegacyDigest } from "../ledger/compat-journal.js";

/** M2 failure codes (downgrade export). */
export const M2_FAIL = {
  ...MIG_DOWN_FAIL,
  COPY_MISSING: "M2_COPY_MISSING",
  UNREPRESENTABLE_UNLISTED: "M2_UNREPRESENTABLE_UNLISTED",
} as const;
export type M2MigrationCode = (typeof M2_FAIL)[keyof typeof M2_FAIL];

/** A legacy export row derived from a v2 occurrence (or an unrepresentable marker). */
export interface LegacyExportRow {
  readonly session: string;
  readonly seq: bigint;
  readonly eventId: string;
  readonly digest: string;
  readonly kind: string;
  readonly legacyProjection: string | null;
  readonly unrepresentable: boolean;
}

/**
 * The host the migration reads from and writes to. copy/validate are read-only
 * over v2; switch is the only mutating step (atomically activating the legacy
 * export as the openable authority). All phase transitions delegate to the
 * compat journal's lifecycle so validate/switch advance the same singleton
 * state machine (prepared→copied→validated→switched).
 */
export interface M2Host {
  readonly db: DatabaseSync;
  /** Durable journal phase (prepared/copied/validated/switched). */
  readonly phase: () => string;
  /** Whether the journal is active (any v2 append journaled). */
  readonly journalActive: () => boolean;
  /** All journaled occurrences (v2 source of truth for the export). */
  readonly journalRows: () => readonly LegacyExportRow[];
  /** Stage the legacy export rows (idempotent; never activates). */
  readonly writeStagedLegacy: (rows: readonly LegacyExportRow[]) => void;
  /** The staged legacy export (null when not yet staged). */
  readonly stagedLegacy: () => readonly LegacyExportRow[] | null;
  /** Validate the staged export against the journal (advances to `validated`). */
  readonly validateStaged: () => { ok: boolean; codes: readonly string[] };
  /** Atomically switch authority to the legacy export (advances to `switched`). */
  readonly switchLegacy: () => void;
}

/** The freshly computed legacy export from the v2 journal (expected bytes). */
export function computeLegacyExport(host: M2Host): readonly LegacyExportRow[] {
  return host.journalRows();
}

/** Phase 1 — copy: stage the legacy export without activating. Returns rows. */
export function m2Copy(host: M2Host): readonly LegacyExportRow[] {
  const rows = computeLegacyExport(host);
  host.writeStagedLegacy(rows);
  return rows;
}

/**
 * Phase 2 — validate: the staged export must equal the freshly computed one
 * (copy-match), the journal must be active and have reached the `copied`
 * phase, seq must be monotonic per session, digests must be well-formed, and
 * every unrepresentable row must be listed. Advances to `validated` only when
 * every check passes (so a crash here leaves authority unchanged).
 */
export function m2Validate(host: M2Host): M2ValidateResult {
  const codes: M2MigrationCode[] = [];
  const staged = host.stagedLegacy();
  const expected = computeLegacyExport(host);

  if (staged === null) {
    codes.push(M2_FAIL.COPY_MISSING);
  } else {
    const sameRows =
      staged.length === expected.length &&
      staged.every(
        (r, i) =>
          r.session === expected[i]!.session &&
          r.seq === expected[i]!.seq &&
          r.eventId === expected[i]!.eventId &&
          r.unrepresentable === expected[i]!.unrepresentable,
      );
    if (!sameRows) codes.push(M2_FAIL.COPY_MISSING);
    // Seq monotonic per session (no regression).
    const prev = new Map<string, bigint>();
    for (const r of staged) {
      const last = prev.get(r.session);
      if (last !== undefined && r.seq <= last) codes.push(M2_FAIL.SEQ_REGRESSION);
      prev.set(r.session, r.seq);
    }
    // Digests on representable rows must verify: recompute sha256 over the stored
    // source and compare to the recorded digest (Q03 — real parity).
    for (const r of staged) {
      if (!r.unrepresentable && !verifyLegacyDigest(r.digest, r.legacyProjection)) {
        codes.push(M2_FAIL.DIGEST_MISMATCH);
      }
    }
    // Every unrepresentable row is explicitly flagged (MIG-DOWN-003).
    for (const r of expected) {
      if (r.unrepresentable) {
        const flag = staged.find(
          (s) => s.session === r.session && s.seq === r.seq && s.unrepresentable,
        );
        if (!flag) codes.push(M2_FAIL.UNREPRESENTABLE_UNLISTED);
      }
    }
  }

  if (!host.journalActive()) codes.push(M2_FAIL.NOT_ACTIVE);
  if (host.phase() !== "copied") codes.push(M2_FAIL.PHASE_UNREACHED);

  if (codes.length === 0) {
    const v = host.validateStaged();
    if (!v.ok) {
      // Q05: narrow the host's string codes through a runtime type guard instead
      // of an unchecked cast — unknown codes are dropped, never mis-typed.
      for (const c of v.codes) if (isM2MigrationCode(c)) codes.push(c);
    }
  }
  const ok = codes.length === 0;
  return { ok, codes: dedupe(codes) };
}

/** M2 downgrade-export validation result. */
export interface M2ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M2MigrationCode[];
}

/**
 * Phase 3 — switch: atomic activation of the legacy export as the openable
 * authority. Only call after m2Validate reports ok; the journal advances to
 * `switched` and v2 becomes read-only-archival. Idempotent on resume.
 */
export function m2Switch(host: M2Host): void {
  host.switchLegacy();
}

/** Registered M2 conformance ID range (M2-001..015). */
export const M2_IDS = [
  "M2-001",
  "M2-002",
  "M2-003",
  "M2-004",
  "M2-005",
  "M2-006",
  "M2-007",
  "M2-008",
  "M2-009",
  "M2-010",
  "M2-011",
  "M2-012",
  "M2-013",
  "M2-014",
  "M2-015",
] as const;

/** Registered MIG-DOWN conformance ID (MIG-DOWN-001). */
export const MIG_DOWN_IDS = ["MIG-DOWN-001"] as const;

/** Runtime narrowing: is `code` a known M2 migration failure code? */
function isM2MigrationCode(code: string): code is M2MigrationCode {
  return (Object.values(M2_FAIL) as string[]).includes(code);
}

function dedupe(codes: M2MigrationCode[]): M2MigrationCode[] {
  const out: M2MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
