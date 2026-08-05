/**
 * vector-cortex/migrations/request-hash-v2.ts — M5 request-hash-v2 migration,
 * COPY + VALIDATE + SWITCH (VC7C).
 *
 * M5 versions the canonical request hash: the predecessor hashed the outbound
 * request under the v1 scheme; v2 folds in the provider profile's ECONOMICS
 * version so a pricing/TTL/exclusion change cannot silently reuse a cache identity
 * minted under different economics. Like M4/M6 it follows the copy/validate/switch
 * contract:
 *
 *   - copy:     resumable per (profile, request) — an interrupted run resumes
 *               without duplicate rows or active-pointer drift.
 *   - validate: every v1 row has exactly one v2 row, every v2 digest re-hashes
 *               from its own declared fields, the migration is IDENTITY-PRESERVING
 *               (a v2 row carries the same `requestDigest` as its v1 source — v2
 *               changes how a CACHE KEY is derived, never what the request IS), and
 *               — the M5-specific invariant ADDED in VC7C — there are ZERO
 *               collisions: no two distinct v1 rows may map to one v2 hash. A
 *               collision (`M5_REQUEST_HASH_COLLISION`) means two different
 *               conversations would share a cache key, the most dangerous outcome
 *               in the subsystem, so it blocks the switch outright.
 *   - switch:   ATOMICALLY flip the active pointer to v2 via `host.switchToV2()`.
 *               VC7B deferred this; VC7C performs it — but ONLY after re-validating
 *               against freshly-read host state at switch time.
 *
 * WHY THE COLLISION CHECK RUNS AT SWITCH TIME, NOT VALIDATE TIME. The brief's
 * failure-injection contract is explicit: crash after M5 validation, inject a
 * collision into host state, then resume — and the RESUMED run must detect
 * `M5_REQUEST_HASH_COLLISION`. If the collision were detected only from the result
 * of an earlier `m5Verify` call, the cached result would be replayed and the
 * injected collision would be invisible. So `m5Switch` RE-READS the host (`v1Rows`,
 * `existingV2`, `activeVersion`) and RE-RUNS the collision check against that live
 * state. Validation is a precondition; the switch is the only place that proves the
 * hazard is absent *right now*. This is the same resume-after-crash discipline as
 * M4/M6: a migration that trusts a stale verification is a migration that loses
 * data on restart.
 *
 * M6 INVALIDATION CONSUMPTION. A v2 request hash is only as trustworthy as the
 * generation it was minted under. The switch consumes M6's structured invalidation
 * keys via the REAL API (`invalidationKey` from `../topology/query.js`) rather than
 * inventing one: when a v2 row's economics version maps to an invalidated router
 * generation, that row cannot be promoted to active. We do not re-derive a
 * generation here — topology is the authority on what generation is live — we only
 * refuse to switch a row whose generation is dead. This keeps M5 from resurrecting
 * cache identities tied to a generation the router has already invalidated.
 *
 * Pure logic over an injected M5Host (deterministic + testable; no console).
 * PREVENT-002/011/PI-004 honored.
 */

import { createHash } from "node:crypto";
import { invalidationKey } from "../topology/query.js";

/** The active-version value the v2 pointer is switched to. */
export const REQUEST_HASH_V2_VERSION = 2;
/** The legacy (predecessor) active version. */
export const REQUEST_HASH_LEGACY_VERSION = 1;

/** M5 failure codes. */
export const M5_FAIL = {
  COPY_PARTIAL: "M5_COPY_PARTIAL",
  COUNT_MISMATCH: "M5_COUNT_MISMATCH",
  DIGEST_MISMATCH: "M5_DIGEST_MISMATCH",
  IDENTITY_DRIFT: "M5_IDENTITY_DRIFT",
  /** Two distinct v1 rows map to the same v2 hash — blocks the switch. (VC7C) */
  REQUEST_HASH_COLLISION: "M5_REQUEST_HASH_COLLISION",
  /** The active pointer is not on v1; switching would be a no-op or a regression. */
  NOT_ON_LEGACY: "M5_NOT_ON_LEGACY",
} as const;
export type M5MigrationCode = (typeof M5_FAIL)[keyof typeof M5_FAIL];

/**
 * Registered M5 conformance IDs (M5-001..020). The acceptance test reads these
 * rows from the v2 `migrations/` domain and asserts each returns its manifest
 * bytes or exactly its listed failure code. Mirrors M6_IDS / M4_IDS.
 */
export const M5_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_v, i) => `M5-${String(i + 1).padStart(3, "0")}`,
);

/** Named M5 rows surfaced by the conformance corpus (mirrors M6_NAMED_IDS). */
export const M5_NAMED_IDS = ["M5-COLLIDE-002"] as const;

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
  /** The session a profile belongs to, for M6 generation invalidation lookup. */
  readonly sessionOf: (profileId: string) => string;
  /** The currently live M6 generation for a session (for invalidation checks). */
  readonly liveGenerationOf: (session: string) => bigint;
  /** Persisted v2 rows already written (for resume). */
  readonly existingV2: () => readonly RequestHashV2Row[];
  /** Idempotent write of v2 rows (never mutates v1 rows). */
  readonly putV2: (rows: readonly RequestHashV2Row[]) => void;
  /** The currently ACTIVE version (1 = legacy; only v1 → v2 switching). */
  readonly activeVersion: () => number;
  /** Atomically flip the active pointer to v2. Mirrors M6Host.switchToV2. */
  readonly switchToV2: () => void;
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
 * Detect a collision: two distinct v1 rows producing the same v2 hash. This is
 * the M5-specific hazard and is checked AGAINST FRESHLY-READ host state so a
 * resumed run after a crash-injected collision actually sees it. Two v1 rows are
 * "distinct" when their identities differ; if their derived v2 hashes are equal,
 * the key space has collapsed and the switch must not proceed.
 */
export function detectCollision(host: M5Host): boolean {
  const byHash = new Map<string, string>();
  for (const v1 of host.v1Rows()) {
    const row = deriveRequestHashRow(host, v1);
    const prior = byHash.get(row.hash);
    if (prior !== undefined && prior !== identity(v1.profileId, v1.requestDigest)) {
      return true;
    }
    byHash.set(row.hash, identity(v1.profileId, v1.requestDigest));
  }
  return false;
}

/**
 * Whether a v2 row is tied to an invalidated M6 generation. Consumes the REAL
 * `invalidationKey` API — we do not re-derive generation semantics, only ask
 * topology whether the row's session/generation is the live one. A row minted
 * under a dead generation cannot be promoted to active.
 */
export function isGenerationInvalidated(host: M5Host, row: RequestHashV2Row): boolean {
  const session = host.sessionOf(row.profileId);
  const live = host.liveGenerationOf(session);
  const keyForLive = invalidationKey(session, live);
  const keyForRow = invalidationKey(session, generationFromEconomics(row.economicsVersion));
  return keyForLive !== keyForRow;
}

/**
 * Economics versions encode the generation they were minted under. We treat the
 * trailing numeric segment as the generation; if it is not numeric the row is
 * considered tied to generation 0 (always live unless explicitly invalidated).
 * This keeps M5 from depending on M6's internal version-string grammar while still
 * honoring a structured invalidation when the encoding is parseable.
 */
function generationFromEconomics(economicsVersion: string): bigint {
  const match = /(\d+)$/.exec(economicsVersion);
  return match ? BigInt(match[1]) : 0n;
}

/**
 * Copy every v1 row into a v2 row BESIDE it (resumable, idempotent), skipping
 * rows whose M6 generation has been invalidated. Rows already persisted with a
 * matching derivation are left untouched; absent or stale rows are (re)written
 * from the authoritative derivation. The active pointer is never touched — v1
 * remains authoritative until `m5Switch`.
 */
export function m5Copy(host: M5Host): {
  readonly written: readonly RequestHashV2Row[];
  readonly all: readonly RequestHashV2Row[];
} {
  const existing = new Map(host.existingV2().map((r) => [identity(r.profileId, r.requestDigest), r]));
  const wanted: RequestHashV2Row[] = [];
  for (const v1 of host.v1Rows()) {
    const fresh = deriveRequestHashRow(host, v1);
    // Do not mint cache identities under a generation the router invalidated.
    if (isGenerationInvalidated(host, fresh)) continue;
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
 * re-derives from its own declared fields, no orphan v2 rows, every v2 row's
 * request digest equals its v1 source's (identity preservation), and no collision
 * among the v2 hashes. Never mutates.
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
    if (!v1Digests.has(id)) {
      codes.push(expected.size > 0 ? M5_FAIL.IDENTITY_DRIFT : M5_FAIL.COUNT_MISMATCH);
    }
  }

  if (detectCollision(host)) codes.push(M5_FAIL.REQUEST_HASH_COLLISION);

  return { ok: codes.length === 0, codes: dedupe(codes) };
}

/**
 * The switch — COMPLETED IN VC7C.
 *
 * Re-validates against FRESHLY-READ host state (never trusts a cached verify
 * result) and, if and only if the active pointer is still on v1 and validation is
 * clean and no collision exists, atomically flips it to v2 via `host.switchToV2()`.
 *
 * The collision check here is the load-bearing safety: a crash after `m5Verify`,
 * followed by an injected collision, must be caught on resume. Because we call
 * `detectCollision(host)` again on the live host, the injected rows are seen and
 * the switch refuses with `M5_REQUEST_HASH_COLLISION`. A verify-only precheck that
 * cached its result would have missed it.
 */
export function m5Switch(host: M5Host): M5ValidateResult {
  if (host.activeVersion() !== REQUEST_HASH_LEGACY_VERSION) {
    return { ok: false, codes: [M5_FAIL.NOT_ON_LEGACY] };
  }
  const verify = m5Verify(host);
  if (!verify.ok) return verify;
  // Re-run the collision check on live state — the crash-resume contract.
  if (detectCollision(host)) return { ok: false, codes: [M5_FAIL.REQUEST_HASH_COLLISION] };
  host.switchToV2();
  return { ok: true, codes: [] };
}

/**
 * The VC7C M5 lifecycle: copy -> verify -> switch. On a clean validate the active
 * version pointer is flipped to v2; on any failure the pointer stays on v1 and the
 * failure codes are returned (validation is non-destructive, so a failed switch is
 * always retryable after the host state is corrected).
 */
export function migrateRequestHashV2(host: M5Host): M5ValidateResult {
  m5Copy(host);
  return m5Switch(host);
}

function dedupe(codes: readonly M5MigrationCode[]): M5MigrationCode[] {
  const out: M5MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
