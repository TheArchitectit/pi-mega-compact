/**
 * vector-cortex/migrations/router-generation-v2.ts — M6 copy/validate/switch
 * migration (VC3C).
 *
 * M6 versions the tiered router's query set: the predecessor routed on ad-hoc
 * per-session keys (no generation identity); VC3C routes on the structured,
 * length-delimited `RouterKeyV2`. M6 copies the old per-session query set into
 * v2 `RouterGenV2Row`s BESIDE the legacy state, validates, and only then
 * atomically switches the active version pointer — the same copy/validate/
 * switch + resume contract as M4.
 *
 *   - copy: resumable per (session, old key) — an interrupted run resumes
 *     without duplicate rows or active-pointer drift.
 *   - validate: every old query key has exactly one v2 row, every row's key is
 *     canonical + re-hashes, and — the VC3C-specific invariant — the new query
 *     set is partition-preserving: a row derived from an old key of session S
 *     MUST carry session S. A row whose session differs is rejected as
 *     cross-session eviction (`M6_CROSS_SESSION_EVICTION`): one session may
 *     never lose or steal another session's query identity.
 *   - switch: atomically flips the ACTIVE VERSION pointer from 1 (legacy) to 2
 *     (router-generation-v2) only after a verified copy; interruption keeps the
 *     old active pointer.
 *
 * Pure logic over an injected M6Host (deterministic + testable; no console).
 * PREVENT-002/011/PI-004 honored.
 */

import { createHash } from "node:crypto";
import {
  encodeRouterKeyV2,
  decodeRouterKeyV2,
  type RouterKeyV2,
} from "../topology/query.js";

/** The active-version value the v2 router generation pointer is switched to. */
export const ROUTER_GEN_V2_VERSION = 2;
/** The legacy (predecessor) active-version value before any verified switch. */
export const ROUTER_GEN_LEGACY_VERSION = 1;

/** M6 failure codes. */
export const M6_FAIL = {
  VERSION_MISMATCH: "M6_VERSION_MISMATCH",
  COPY_PARTIAL: "M6_COPY_PARTIAL",
  COUNT_MISMATCH: "M6_COUNT_MISMATCH",
  DIGEST_MISMATCH: "M6_DIGEST_MISMATCH",
  BAD_OLD_KEY: "M6_BAD_OLD_KEY",
  CROSS_SESSION_EVICTION: "M6_CROSS_SESSION_EVICTION",
  SWITCH_PRECONDITION: "M6_SWITCH_PRECONDITION",
} as const;
export type M6MigrationCode = (typeof M6_FAIL)[keyof typeof M6_FAIL];

/**
 * A v2 router-generation row derived from one predecessor query key. Identity is
 * exact: `session` + the canonical length-delimited `key` (all five structured
 * fields). `digest` is the authoritative sha256 over the canonical key bytes.
 */
export interface RouterGenV2Row {
  readonly session: string;
  readonly generation: bigint;
  readonly sourceStart: bigint;
  readonly sourceEnd: bigint;
  readonly algorithm: string;
  /** Canonical `rk2:` hex encoding of the full structured key. */
  readonly key: string;
  /** Authoritative sha256 hex over the canonical key bytes. */
  readonly digest: string;
}

/** The host the migration reads from / writes to (capability-shaped). */
export interface M6Host {
  /** Every session whose query set is being migrated. */
  readonly sessions: () => readonly string[];
  /** The predecessor (legacy) query keys for one session. */
  readonly oldKeysOf: (session: string) => readonly string[];
  /**
   * Decode one predecessor query key into the structured RouterKeyV2 it maps to,
   * or a `M6_BAD_OLD_KEY` rejection when the legacy key cannot be interpreted.
   */
  readonly parseOldKey: (
    session: string,
    oldKey: string,
  ) => { ok: true; key: RouterKeyV2 } | { ok: false };
  /** Persisted v2 rows already written (for resume + active pointer). */
  readonly existingV2: () => readonly RouterGenV2Row[];
  /** Idempotent write of v2 rows (never mutates legacy rows). */
  readonly putV2: (rows: readonly RouterGenV2Row[]) => void;
  /** The currently ACTIVE version (1 = legacy until a verified switch). */
  readonly activeVersion: () => number;
  /** Atomically switch the active version pointer to 2. */
  readonly switchToV2: () => void;
}

/** An M6 migration validation result. */
export interface M6ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M6MigrationCode[];
}

/** The identity of a query-set slot, for copy/resume dedup. */
interface SlotId {
  readonly session: string;
  readonly oldKey: string;
}

/** Derive one v2 row from an old key (authoritative bytes). */
export function deriveRouterGenRow(
  host: M6Host,
  session: string,
  oldKey: string,
): { ok: true; row: RouterGenV2Row } | { ok: false; session: string; oldKey: string } {
  const parsed = host.parseOldKey(session, oldKey);
  if (!parsed.ok) return { ok: false, session, oldKey };
  const key = parsed.key;
  // Cross-session guard at COPY time: the structured key's session must equal
  // the slot session. A key that claims a different session is never copied.
  if (key.session !== session) return { ok: false, session, oldKey };
  const encoded = encodeRouterKeyV2(key);
  return {
    ok: true,
    row: {
      session,
      generation: key.generation,
      sourceStart: key.sourceStart,
      sourceEnd: key.sourceEnd,
      algorithm: key.algorithm,
      key: encoded,
      digest: sha256Hex(Buffer.from(encoded.slice(4), "hex")),
    },
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copy the full old query set into v2 rows (resumable): rows already persisted
 * with a matching canonical key + digest are left untouched (no duplicates);
 * absent or corrupt (wrong session / wrong key / stale digest / bad old key)
 * slots are (re)written from the authoritative derivation. Returns the delta
 * written this call. The active pointer stays at the legacy version until a
 * verified switch.
 */
export function m6Copy(host: M6Host): { readonly written: RouterGenV2Row[]; readonly all: RouterGenV2Row[] } {
  const existing = new Map(host.existingV2().map((r) => [`${r.session}::${r.key}`, r]));
  const wanted: RouterGenV2Row[] = [];
  for (const session of host.sessions()) {
    for (const oldKey of host.oldKeysOf(session)) {
      const derived = deriveRouterGenRow(host, session, oldKey);
      if (!derived.ok) continue; // bad old key surfaced by verify, not lost silently
      const stored = existing.get(`${session}::${derived.row.key}`);
      if (stored !== undefined && rowMatches(stored, derived.row)) continue; // healthy
      wanted.push(derived.row);
    }
  }
  if (wanted.length > 0) host.putV2(wanted);
  return { written: wanted, all: [...host.existingV2()] };
}

/** True when a persisted row already matches the authoritative derivation. */
function rowMatches(stored: RouterGenV2Row, fresh: RouterGenV2Row): boolean {
  return (
    stored.session === fresh.session &&
    stored.generation === fresh.generation &&
    stored.sourceStart === fresh.sourceStart &&
    stored.sourceEnd === fresh.sourceEnd &&
    stored.algorithm === fresh.algorithm &&
    stored.key === fresh.key &&
    stored.digest === fresh.digest
  );
}

/**
 * Verify the migrated query set: every old query key across every session has a
 * v2 row (exact-once), every row's key is canonical + re-hashes, and the new set
 * is partition-preserving — every row's session is exactly the session of the
 * old key it was derived from (rejects cross-session eviction). Never mutates.
 *
 * Comparison of old/new query sets is exact-by-identity (structured key bytes),
 * never by string prefix.
 */
export function m6Verify(host: M6Host): M6ValidateResult {
  const codes: M6MigrationCode[] = [];
  const stored = host.existingV2();

  // Expected slot inventory: (session, canonical key) for every derivable old key.
  const expectedSlots: SlotId[] = [];
  const badOldKeys: SlotId[] = [];
  for (const session of host.sessions()) {
    for (const oldKey of host.oldKeysOf(session)) {
      const parsed = host.parseOldKey(session, oldKey);
      if (!parsed.ok) {
        badOldKeys.push({ session, oldKey });
        continue;
      }
      if (parsed.key.session !== session) {
        // A structured key that claims a different session is a cross-session
        // eviction attempt — never migrated, never evicted.
        codes.push(M6_FAIL.CROSS_SESSION_EVICTION);
        continue;
      }
      expectedSlots.push({ session, oldKey });
    }
  }
  if (badOldKeys.length > 0) codes.push(M6_FAIL.BAD_OLD_KEY);

  // Map stored rows by their (session,key) identity.
  const byIdentity = new Map<string, RouterGenV2Row>();
  const duplicateCheck = new Map<string, number>();
  for (const r of stored) {
    const ident = `${r.session}::${r.key}`;
    byIdentity.set(ident, r);
    duplicateCheck.set(ident, (duplicateCheck.get(ident) ?? 0) + 1);
  }

  // Each expected slot must be present exactly once, with a healthy row.
  for (const slot of expectedSlots) {
    const parsed = host.parseOldKey(slot.session, slot.oldKey);
    if (!parsed.ok) continue;
    const expectedKey = encodeRouterKeyV2(parsed.key);
    const ident = `${slot.session}::${expectedKey}`;
    const count = duplicateCheck.get(ident) ?? 0;
    if (count === 0) codes.push(M6_FAIL.COPY_PARTIAL);
    if (count > 1) codes.push(M6_FAIL.COUNT_MISMATCH);
  }

  // Row health: digest re-hashes + session partition-preserving.
  for (const r of stored) {
    if (!r.key.startsWith("rk2:")) codes.push(M6_FAIL.DIGEST_MISMATCH);
    const expectedDigest = sha256Hex(Buffer.from(r.key.slice(4), "hex"));
    if (r.digest !== expectedDigest) codes.push(M6_FAIL.DIGEST_MISMATCH);
    // The row's own structured key must decode and agree with its declared fields.
    const dec = decodeRow(r);
    if (!dec) codes.push(M6_FAIL.DIGEST_MISMATCH);
  }

  // No stored row may be an orphan (no corresponding old key anywhere).
  const expectedIdentities = new Set<string>();
  for (const slot of expectedSlots) {
    const parsed = host.parseOldKey(slot.session, slot.oldKey);
    if (!parsed.ok) continue;
    expectedIdentities.add(`${slot.session}::${encodeRouterKeyV2(parsed.key)}`);
  }
  for (const ident of byIdentity.keys()) {
    if (!expectedIdentities.has(ident)) codes.push(M6_FAIL.COUNT_MISMATCH);
  }

  const ok = codes.length === 0;
  return { ok, codes: dedupe(codes) };
}

/**
 * Self-consistent decode of a stored row: its canonical key decodes to a
 * RouterKeyV2 whose five fields equal the row's declared fields. A row whose key
 * doesn't round-trip against its own declared session/generation/range/algorithm
 * is corrupt (cannot be trusted as the query set's identity).
 */
function decodeRow(r: RouterGenV2Row): boolean {
  if (!r.key.startsWith("rk2:")) return false;
  const hex = r.key.slice(4);
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return false;
  const dec = decodeRouterKeyV2(r.key);
  if (!dec.ok) return false;
  return (
    dec.key.session === r.session &&
    dec.key.generation === r.generation &&
    dec.key.sourceStart === r.sourceStart &&
    dec.key.sourceEnd === r.sourceEnd &&
    dec.key.algorithm === r.algorithm
  );
}

/**
 * Switch the active version to 2. Only call after `m6Verify` reports ok; a
 * crash/return before switch leaves the legacy pointer active (interruption
 * keeps old authority, resumable idempotently).
 */
export function m6Switch(host: M6Host): void {
  if (host.activeVersion() !== ROUTER_GEN_LEGACY_VERSION) return;
  host.switchToV2();
}

/** Full M6 lifecycle: copy -> verify -> switch; returns the verify result. */
export function migrateRouterGenerationV2(host: M6Host): M6ValidateResult {
  m6Copy(host);
  const v = m6Verify(host);
  if (v.ok) m6Switch(host);
  return v;
}

/** Registered M6 conformance ID range (M6-001..012). */
export const M6_IDS = [
  "M6-001",
  "M6-002",
  "M6-003",
  "M6-004",
  "M6-005",
  "M6-006",
  "M6-007",
  "M6-008",
  "M6-009",
  "M6-010",
  "M6-011",
  "M6-012",
] as const;

/** Registered named M6 conformance IDs. */
export const M6_NAMED_IDS = [
  "M6-KEY-001",
  "M6-STALE-002",
] as const;

function dedupe(codes: readonly M6MigrationCode[]): M6MigrationCode[] {
  const out: M6MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
