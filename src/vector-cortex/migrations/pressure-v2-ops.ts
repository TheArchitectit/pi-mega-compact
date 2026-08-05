/**
 * pressure-v2-ops.ts — M7 migration operational logic (copy/validate/switch).
 *
 * Extracted from pressure-v2.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Pure logic over an injected M7Host;
 * deterministic + testable; no console. PREVENT-002/011/PI-004 honored.
 *
 * WHY THE LABEL CHECK RE-READS THE HOST AT SWITCH TIME. The sprint's failure
 * injection is explicit: kill the process after the copy phase, insert an
 * unknown legacy pressure row, then resume — and the resumed run must return
 * M7_PRESSURE_UNKNOWN and KEEP THE OLD POINTER. If the switch trusted the
 * verdict of an earlier verify call, the injected row would be invisible and
 * the pointer would flip over a store that still holds an uncanonical label.
 * So `m7Switch` re-reads `v1Rows`/`existingV2`/`activeVersion` and re-validates
 * against that live state. Validation is a precondition; the switch is the only
 * place that proves the hazard is absent *right now*.
 */

import { createHash } from "node:crypto";

import { isPressureLevel } from "../controller/policy.js";
import type {
  M7Host,
  M7MigrationCode,
  M7ValidateResult,
  PressureV1Row,
  PressureV2Row,
} from "./pressure-v2-types.js";
import { M7_FAIL, PRESSURE_LEGACY_VERSION } from "./pressure-v2-types.js";

/** Length-prefixed framing so the folded fields cannot alias. */
function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/** Row identity is (session, effectiveSeq) — one pressure per sequence point. */
const identity = (sessionId: string, effectiveSeq: number): string =>
  `${sessionId}::${effectiveSeq}`;

/** The authoritative v2 digest: SHA-256 over the length-prefixed fields. */
export function derivePressureDigest(
  sessionId: string,
  level: string,
  effectiveSeq: number,
  ts: string,
): string {
  return createHash("sha256")
    .update(
      field("pressure-v2") +
        field(sessionId) +
        field(level) +
        field(String(effectiveSeq)) +
        field(ts),
      "utf8",
    )
    .digest("hex");
}

/**
 * Map ONE legacy row to its v2 form. ONLY the canonical five labels map;
 * anything else throws `{ code: M7_PRESSURE_UNKNOWN }`. There is deliberately
 * no fallback branch — a coerced label is a silently misclassified workload.
 */
export function mapPressureRow(v1: PressureV1Row): PressureV2Row {
  if (!isPressureLevel(v1.label)) {
    throw { code: M7_FAIL.PRESSURE_UNKNOWN };
  }
  return {
    sessionId: v1.sessionId,
    level: v1.label,
    effectiveSeq: v1.effectiveSeq,
    ts: v1.ts,
    digest: derivePressureDigest(
      v1.sessionId,
      v1.label,
      v1.effectiveSeq,
      v1.ts,
    ),
  };
}

/** True when every legacy row carries a canonical label. */
export function allLabelsCanonical(host: M7Host): boolean {
  return host.v1Rows().every((r) => isPressureLevel(r.label));
}

/**
 * COPY: resumable per (session, effectiveSeq). An interrupted run resumes
 * without duplicate rows. An uncanonical label aborts the copy with
 * M7_PRESSURE_UNKNOWN before anything is written.
 */
export function m7Copy(host: M7Host): {
  readonly written: readonly PressureV2Row[];
  readonly all: readonly PressureV2Row[];
} {
  const existing = new Map(
    host.existingV2().map((r) => [identity(r.sessionId, r.effectiveSeq), r]),
  );
  const wanted: PressureV2Row[] = [];
  for (const v1 of host.v1Rows()) {
    // Throws M7_PRESSURE_UNKNOWN for a non-canonical label.
    const fresh = mapPressureRow(v1);
    const stored = existing.get(identity(v1.sessionId, v1.effectiveSeq));
    if (stored !== undefined && stored.digest === fresh.digest) continue;
    wanted.push(fresh);
  }
  if (wanted.length > 0) host.putV2(wanted);
  return { written: wanted, all: [...host.existingV2()] };
}

function dedupe(codes: readonly M7MigrationCode[]): M7MigrationCode[] {
  const out: M7MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}

/**
 * VALIDATE: compare counts and digests between v1 and v2, and re-check every
 * legacy label. Returns codes rather than throwing so a caller sees every
 * problem at once.
 */
export function m7Verify(host: M7Host): M7ValidateResult {
  const codes: M7MigrationCode[] = [];
  const v1Rows = host.v1Rows();
  const stored = host.existingV2();

  // Label check first: an uncanonical legacy label invalidates the whole run.
  for (const v1 of v1Rows) {
    if (!isPressureLevel(v1.label)) codes.push(M7_FAIL.PRESSURE_UNKNOWN);
  }

  const counts = new Map<string, number>();
  for (const r of stored) {
    const id = identity(r.sessionId, r.effectiveSeq);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const expected = new Set<string>();
  for (const v1 of v1Rows) {
    if (!isPressureLevel(v1.label)) continue;
    const id = identity(v1.sessionId, v1.effectiveSeq);
    expected.add(id);
    const n = counts.get(id) ?? 0;
    if (n === 0) codes.push(M7_FAIL.COPY_PARTIAL);
    if (n > 1) codes.push(M7_FAIL.COUNT_MISMATCH);
  }

  // Every stored row must re-derive its own digest and correspond to a v1 row.
  for (const r of stored) {
    const fresh = derivePressureDigest(
      r.sessionId,
      r.level,
      r.effectiveSeq,
      r.ts,
    );
    if (r.digest !== fresh) codes.push(M7_FAIL.DIGEST_MISMATCH);
    if (!expected.has(identity(r.sessionId, r.effectiveSeq))) {
      codes.push(M7_FAIL.COUNT_MISMATCH);
    }
  }

  return { ok: codes.length === 0, codes: dedupe(codes) };
}

/**
 * SWITCH: atomically flip the active pointer to v2 — but ONLY after
 * re-validating against freshly-read host state (see the module note on the
 * post-copy failure injection). The pointer is left untouched on any failure.
 */
export function m7Switch(host: M7Host): M7ValidateResult {
  if (host.activeVersion() !== PRESSURE_LEGACY_VERSION) {
    return { ok: false, codes: [M7_FAIL.NOT_ON_LEGACY] };
  }
  // Re-read the live rows: an unknown label injected after the copy is caught
  // here, and the old pointer survives.
  if (!allLabelsCanonical(host)) {
    return { ok: false, codes: [M7_FAIL.PRESSURE_UNKNOWN] };
  }
  const verify = m7Verify(host);
  if (!verify.ok) return verify;
  host.switchToV2();
  return { ok: true, codes: [] };
}

/**
 * Full M7 migration: copy, then validate + switch. An uncanonical label thrown
 * during the copy is converted to a result code so the caller sees the same
 * shape as a validation failure, and the pointer is left on legacy.
 */
export function migratePressureV2(host: M7Host): M7ValidateResult {
  try {
    m7Copy(host);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code: unknown }).code
        : undefined;
    if (code === M7_FAIL.PRESSURE_UNKNOWN) {
      return { ok: false, codes: [M7_FAIL.PRESSURE_UNKNOWN] };
    }
    throw err;
  }
  return m7Switch(host);
}
