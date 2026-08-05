/**
 * request-hash-v2-ops.ts — M5 migration operational logic (copy/verify/switch).
 *
 * Extracted from request-hash-v2.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Pure logic over an injected M5Host;
 * deterministic + testable; no console. PREVENT-002/011/PI-004 honored.
 */
import { createHash } from "node:crypto";
import { invalidationKey } from "../topology/query.js";
import type {
  M5Host,
  M5MigrationCode,
  M5ValidateResult,
  RequestHashV1Row,
  RequestHashV2Row,
} from "./request-hash-v2-types.js";
import {
  M5_FAIL,
  REQUEST_HASH_LEGACY_VERSION,
} from "./request-hash-v2-types.js";

/** Length-prefixed framing so the folded fields cannot alias. */
function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

const identity = (profileId: string, requestDigest: string): string =>
  `${profileId}::${requestDigest}`;

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
      field("request-hash-v2") +
        field(profileId) +
        field(requestDigest) +
        field(economicsVersion),
      "utf8",
    )
    .digest("hex");
}

/** Derive the v2 row for one v1 row. */
export function deriveRequestHashRow(
  host: M5Host,
  v1: RequestHashV1Row,
): RequestHashV2Row {
  const economicsVersion = host.economicsVersionOf(v1.profileId);
  return {
    profileId: v1.profileId,
    // IDENTITY-PRESERVING: carried through verbatim, never re-derived.
    requestDigest: v1.requestDigest,
    economicsVersion,
    hash: deriveRequestHashV2(v1.profileId, v1.requestDigest, economicsVersion),
  };
}

/**
 * Economics versions encode the generation they were minted under. We treat the
 * trailing numeric segment as the generation; if it is not numeric the row is
 * considered tied to generation 0 (always live unless explicitly invalidated).
 */
function generationFromEconomics(economicsVersion: string): bigint {
  const match = /(\d+)$/.exec(economicsVersion);
  return match ? BigInt(match[1]) : 0n;
}

export function detectCollision(host: M5Host): boolean {
  const byHash = new Map<string, string>();
  const seenIdentities = new Set<string>();
  for (const v1 of host.v1Rows()) {
    const row = deriveRequestHashRow(host, v1);
    const id = identity(v1.profileId, v1.requestDigest);
    // Two distinct v1 rows (different v1 hash) with the same v2 hash collide,
    // even if they share an identity — the v2 table cannot distinguish them.
    if (seenIdentities.has(id)) return true;
    seenIdentities.add(id);
    const prior = byHash.get(row.hash);
    if (prior !== undefined && prior !== id) return true;
    byHash.set(row.hash, id);
  }
  return false;
}

export function isGenerationInvalidated(
  host: M5Host,
  row: RequestHashV2Row,
): boolean {
  const session = host.sessionOf(row.profileId);
  const live = host.liveGenerationOf(session);
  const keyForLive = invalidationKey(session, live);
  const keyForRow = invalidationKey(
    session,
    generationFromEconomics(row.economicsVersion),
  );
  return keyForLive !== keyForRow;
}

export function m5Copy(host: M5Host): {
  readonly written: readonly RequestHashV2Row[];
  readonly all: readonly RequestHashV2Row[];
} {
  const existing = new Map(
    host.existingV2().map((r) => [identity(r.profileId, r.requestDigest), r]),
  );
  const wanted: RequestHashV2Row[] = [];
  for (const v1 of host.v1Rows()) {
    const fresh = deriveRequestHashRow(host, v1);
    if (isGenerationInvalidated(host, fresh)) continue;
    const stored = existing.get(identity(v1.profileId, v1.requestDigest));
    if (
      stored !== undefined &&
      stored.hash === fresh.hash &&
      stored.economicsVersion === fresh.economicsVersion
    ) {
      continue;
    }
    wanted.push(fresh);
  }
  if (wanted.length > 0) host.putV2(wanted);
  return { written: wanted, all: [...host.existingV2()] };
}

function dedupe(codes: readonly M5MigrationCode[]): M5MigrationCode[] {
  const out: M5MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}

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
    // Dead-generation rows are intentionally skipped by copy; do not flag.
    const fresh = deriveRequestHashRow(host, v1);
    if (isGenerationInvalidated(host, fresh)) continue;
    expected.add(id);
    const n = counts.get(id) ?? 0;
    if (n === 0) codes.push(M5_FAIL.COPY_PARTIAL);
    if (n > 1) codes.push(M5_FAIL.COUNT_MISMATCH);
  }

  const v1Digests = new Set(
    v1Rows.map((r) => identity(r.profileId, r.requestDigest)),
  );
  for (const r of stored) {
    const fresh = deriveRequestHashV2(
      r.profileId,
      r.requestDigest,
      r.economicsVersion,
    );
    if (r.hash !== fresh) codes.push(M5_FAIL.DIGEST_MISMATCH);
    const id = identity(r.profileId, r.requestDigest);
    if (!v1Digests.has(id)) {
      codes.push(
        expected.size > 0 ? M5_FAIL.IDENTITY_DRIFT : M5_FAIL.COUNT_MISMATCH,
      );
    }
  }

  if (detectCollision(host)) codes.push(M5_FAIL.REQUEST_HASH_COLLISION);

  return { ok: codes.length === 0, codes: dedupe(codes) };
}

export function m5Switch(host: M5Host): M5ValidateResult {
  if (host.activeVersion() !== REQUEST_HASH_LEGACY_VERSION) {
    return { ok: false, codes: [M5_FAIL.NOT_ON_LEGACY] };
  }
  // Collision check runs before copy-completeness verify: a structural
  // collision is a switch-blocker regardless of copy state.
  if (detectCollision(host))
    return { ok: false, codes: [M5_FAIL.REQUEST_HASH_COLLISION] };
  const verify = m5Verify(host);
  if (!verify.ok) return verify;
  host.switchToV2();
  return { ok: true, codes: [] };
}

export function migrateRequestHashV2(host: M5Host): M5ValidateResult {
  m5Copy(host);
  return m5Switch(host);
}
