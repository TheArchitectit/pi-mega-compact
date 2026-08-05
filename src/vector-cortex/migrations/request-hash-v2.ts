/**
 * vector-cortex/migrations/request-hash-v2.ts — M5 request-hash-v2, COPY +
 * VALIDATE ONLY (VC7B). The switch lands in VC7C.
 *
 * M5 versions the canonical request hash: the predecessor hashed the outbound
 * request under the v1 scheme; v2 folds in the provider profile's ECONOMICS
 * version so a pricing/TTL/exclusion change cannot silently reuse a cache
 * identity minted under different economics. Like M4/M6 it follows the
 * copy/validate/switch contract — but VC7B deliberately stops after validate:
 *
 *   - copy:     resumable per (profile, request) — an interrupted run resumes
 *               without duplicate rows or active-pointer drift.
 *   - validate: every v1 row has exactly one v2 row, every v2 digest re-hashes
 *               from its own declared fields, and — the M5-specific invariant —
 *               the migration is IDENTITY-PRESERVING: a v2 row must carry the
 *               same `requestDigest` as the v1 row it came from. v2 changes how
 *               a CACHE KEY is derived, never what the request IS. A row whose
 *               request digest drifted is rejected (`M5_IDENTITY_DRIFT`).
 *   - switch:   NOT IMPLEMENTED IN VC7B. `m5Switch` exists so the shape of the
 *               lifecycle is reviewable, but it always refuses with
 *               `M5_SWITCH_DEFERRED` and leaves the active pointer on v1.
 *
 * WHY THE SWITCH IS WITHHELD. Flipping the request-hash version invalidates
 * every crystal minted under v1 in one step. VC7C first runs the shadow
 * comparison (v1 vs v2 digests over live traffic) so the blast radius is
 * measured before it is taken. Shipping the switch here would mean flipping it
 * on evidence that does not exist yet — so the function is present, refuses, and
 * says why, rather than being a TODO comment someone later mistakes for done.
 * Old-binary protocol: a reader that predates v2 keeps reading v1 rows, which
 * remain untouched and authoritative for the whole of VC7B.
 *
 * Pure logic over an injected M5Host (deterministic + testable; no console).
 * PREVENT-002/011/PI-004 honored.
 */

import { createHash } from "node:crypto";

/** The active-version value the v2 pointer will be switched to — in VC7C. */
export const REQUEST_HASH_V2_VERSION = 2;
/** The legacy (predecessor) active version; VC7B never leaves this. */
export const REQUEST_HASH_LEGACY_VERSION = 1;

/** M5 failure codes. */
export const M5_FAIL = {
  COPY_PARTIAL: "M5_COPY_PARTIAL",
  COUNT_MISMATCH: "M5_COUNT_MISMATCH",
  DIGEST_MISMATCH: "M5_DIGEST_MISMATCH",
  IDENTITY_DRIFT: "M5_IDENTITY_DRIFT",
  SWITCH_DEFERRED: "M5_SWITCH_DEFERRED",
} as const;
export type M5MigrationCode = (typeof M5_FAIL)[keyof typeof M5_FAIL];

/** A predecessor (v1) request-hash row. */
export interface RequestHashV1Row {
  readonly profileId: string;
  /** BARE lowercase hex canonical request digest (VC5B convention). */
  readonly requestDigest: string;
  /** The v1 cache-identity hash derived from the request. */
  readonly hash: string;
}

/**
 * A v2 request-hash row. Identity is `(profileId, requestDigest)` — unchanged
 * from v1, which is the point: only `hash` is re-derived, now folding in the
 * economics version.
 */
export interface RequestHashV2Row {
  readonly profileId: string;
  readonly requestDigest: string;
  /** Economics version folded into the v2 hash (absent in v1). */
  readonly economicsVersion: string;
  /** The v2 cache-identity hash. */
  readonly hash: string;
}

/** The host the migration reads from / writes to (capability-shaped). */
export interface M5Host {
  /** Every predecessor row being migrated. */
  readonly v1Rows: () => readonly RequestHashV1Row[];
  /** The economics version to fold in, per profile. */
  readonly economicsVersionOf: (profileId: string) => string;
  /** Persisted v2 rows already written (for resume). */
  readonly existingV2: () => readonly RequestHashV2Row[];
  /** Idempotent write of v2 rows (never mutates v1 rows). */
  readonly putV2: (rows: readonly RequestHashV2Row[]) => void;
  /** The currently ACTIVE version (1 = legacy; VC7B never changes it). */
  readonly activeVersion: () => number;
}

/** An M5 validation result. */
export interface M5ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M5MigrationCode[];
}

/** Length-prefixed framing so the folded fields cannot alias. */
function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * The authoritative v2 hash: SHA-256 over the version tag, profile, request
 * digest, and economics version. Length-prefixed for injectivity, exactly as the
 * crystal key encoder frames its fields.
 */
export function deriveRequestHashV2(
  profileId: string,
  requestDigest: string,
  economicsVersion: string,
): string {
  return createHash("sha256")
    .update(
      field("request-hash-v2") + field(profileId) + field(requestDigest) + field(economicsVersion),
      "utf8",
    )
    .digest("hex");
}

/** Derive the v2 row for one v1 row. */
export function deriveRequestHashRow(host: M5Host, v1: RequestHashV1Row): RequestHashV2Row {
  const economicsVersion = host.economicsVersionOf(v1.profileId);
  return {
    profileId: v1.profileId,
    // IDENTITY-PRESERVING: carried through verbatim, never re-derived.
    requestDigest: v1.requestDigest,
    economicsVersion,
    hash: deriveRequestHashV2(v1.profileId, v1.requestDigest, economicsVersion),
  };
}

const identity = (profileId: string, requestDigest: string): string =>
  `${profileId}::${requestDigest}`;

/**
 * Copy every v1 row into a v2 row BESIDE it (resumable, idempotent). Rows already
 * persisted with a matching derivation are left untouched; absent or stale rows
 * are (re)written from the authoritative derivation. The active pointer is never
 * touched — v1 remains authoritative throughout VC7B.
 */
export function m5Copy(host: M5Host): {
  readonly written: readonly RequestHashV2Row[];
  readonly all: readonly RequestHashV2Row[];
} {
  const existing = new Map(host.existingV2().map((r) => [identity(r.profileId, r.requestDigest), r]));
  const wanted: RequestHashV2Row[] = [];
  for (const v1 of host.v1Rows()) {
    const fresh = deriveRequestHashRow(host, v1);
    const stored = existing.get(identity(v1.profileId, v1.requestDigest));
    if (
      stored !== undefined &&
      stored.hash === fresh.hash &&
      stored.economicsVersion === fresh.economicsVersion
    ) {
      continue; // healthy, already copied
    }
    wanted.push(fresh);
  }
  if (wanted.length > 0) host.putV2(wanted);
  return { written: wanted, all: [...host.existingV2()] };
}

/**
 * Validate the copied set: exactly one v2 row per v1 row, every v2 hash
 * re-derives from its own declared fields, no orphan v2 rows, and every v2 row's
 * request digest equals its v1 source's (identity preservation). Never mutates.
 */
export function m5Verify(host: M5Host): M5ValidateResult {
  const codes: M5MigrationCode[] = [];
  const stored = host.existingV2();
  const v1Rows = host.v1Rows();

  const counts = new Map<string, number>();
  for (const r of stored) {
    const id = identity(r.profileId, r.requestDigest);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const expected = new Set<string>();
  for (const v1 of v1Rows) {
    const id = identity(v1.profileId, v1.requestDigest);
    expected.add(id);
    const n = counts.get(id) ?? 0;
    if (n === 0) codes.push(M5_FAIL.COPY_PARTIAL);
    if (n > 1) codes.push(M5_FAIL.COUNT_MISMATCH);
  }

  // Every v1 request digest that must survive the migration unchanged.
  const v1Digests = new Set(v1Rows.map((r) => identity(r.profileId, r.requestDigest)));
  for (const r of stored) {
    const fresh = deriveRequestHashV2(r.profileId, r.requestDigest, r.economicsVersion);
    if (r.hash !== fresh) codes.push(M5_FAIL.DIGEST_MISMATCH);
    const id = identity(r.profileId, r.requestDigest);
    // A v2 row whose identity has no v1 source either drifted or is an orphan.
    if (!v1Digests.has(id)) {
      codes.push(expected.size > 0 ? M5_FAIL.IDENTITY_DRIFT : M5_FAIL.COUNT_MISMATCH);
    }
  }

  return { ok: codes.length === 0, codes: dedupe(codes) };
}

/**
 * The switch — DEFERRED TO VC7C BY DESIGN.
 *
 * Always refuses and always leaves the active pointer on v1. It exists so the
 * lifecycle is complete and reviewable, and so a caller that tries to switch
 * early gets an explicit `M5_SWITCH_DEFERRED` instead of silence.
 */
export function m5Switch(host: M5Host): M5ValidateResult {
  void host;
  return { ok: false, codes: [M5_FAIL.SWITCH_DEFERRED] };
}

/**
 * The VC7B M5 lifecycle: copy -> verify. NO SWITCH. Returns the verify result;
 * the active version pointer is guaranteed to still be
 * `REQUEST_HASH_LEGACY_VERSION` on return.
 */
export function migrateRequestHashV2CopyValidate(host: M5Host): M5ValidateResult {
  m5Copy(host);
  return m5Verify(host);
}

function dedupe(codes: readonly M5MigrationCode[]): M5MigrationCode[] {
  const out: M5MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
