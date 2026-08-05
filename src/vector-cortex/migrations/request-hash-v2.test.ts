/**
 * migrations/request-hash-v2.test.ts — VC7C M5 copy/validate/SWITCH coverage.
 *
 * Drives the REAL migration from `./request-hash-v2-ops.js` (re-exported by
 * `./request-hash-v2.js`): `migrateRequestHashV2(host)` performs copy + validate
 * + switch. The host is an in-memory `M5Host` implementing the capability
 * interface; no mocks of the arithmetic. Mirrors `minhash-v2.test.ts` style.
 *
 * The headline invariants pinned here:
 *   - identity-preserving: every v2 row carries the SAME requestDigest as its v1
 *     source (v2 changes the KEY, never what the request IS).
 *   - ZERO collisions required: two distinct v1 rows mapping to one v2 hash block
 *     the switch with M5_REQUEST_HASH_COLLISION.
 *   - resume-after-crash: the switch RE-VALIDATES against freshly-read host state,
 *     so a collision injected AFTER validation is caught at switch time.
 *   - NOT_ON_LEGACY: already on v2, no double switch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migrateRequestHashV2,
  m5Copy,
  m5Verify,
  m5Switch,
  deriveRequestHashV2,
} from "./request-hash-v2.js";
import { M5_FAIL, REQUEST_HASH_LEGACY_VERSION, REQUEST_HASH_V2_VERSION } from "./request-hash-v2.js";
import type { M5Host, RequestHashV1Row, RequestHashV2Row } from "./request-hash-v2.js";

/** In-memory M5Host honoring the capability interface. */
function host(opts: {
  v1: RequestHashV1Row[];
  econ: Record<string, string>;
  active?: number;
  sessions?: Record<string, string>;
  liveGen?: Record<string, bigint>;
}): M5Host & { v2: RequestHashV2Row[]; switchedTo: number | null } {
  const v2: RequestHashV2Row[] = [];
  let active = opts.active ?? REQUEST_HASH_LEGACY_VERSION;
  return {
    v1Rows: () => opts.v1,
    economicsVersionOf: (p) => opts.econ[p] ?? "econ-1",
    sessionOf: (p) => opts.sessions?.[p] ?? "s1",
    liveGenerationOf: (s) => opts.liveGen?.[s] ?? 1n,
    existingV2: () => v2,
    putV2: (rows) => v2.push(...rows),
    activeVersion: () => active,
    switchToV2: () => {
      active = REQUEST_HASH_V2_VERSION;
    },
    v2,
    get switchedTo() {
      return active === REQUEST_HASH_V2_VERSION ? REQUEST_HASH_V2_VERSION : null;
    },
  };
}

const v1 = (profileId: string, reqText: string, hashText: string): RequestHashV1Row => ({
  profileId,
  requestDigest: deriveRequestHashV2(profileId, reqText, "x").slice(0, 8) + reqText,
  hash: deriveRequestHashV2(profileId, hashText, "x").slice(0, 8) + hashText,
});

const row = (profileId: string, reqText: string) =>
  v1(profileId, reqText, `${profileId}:${reqText}`);

test("M5: a single v1 row migrates to exactly one v2 row carrying the same request digest", () => {
  const h = host({ v1: [row("p-a", "req-1")], econ: { "p-a": "econ-1" } });
  const { written } = m5Copy(h);
  assert.equal(written.length, 1, "exactly one v2 row");
  assert.equal(written[0].requestDigest, row("p-a", "req-1").requestDigest, "identity preserved verbatim");
});

test("M5: migrate switches the active pointer to v2 and reports ok", () => {
  const h = host({ v1: [row("p-a", "req-1")], econ: { "p-a": "econ-1" } });
  const res = migrateRequestHashV2(h);
  assert.equal(res.ok, true);
  assert.deepEqual(res.codes, []);
  assert.equal(h.switchedTo, REQUEST_HASH_V2_VERSION);
});

test("M5: verify rejects a row whose hash does not re-derive (DIGEST_MISMATCH)", () => {
  const bad: RequestHashV2Row = {
    profileId: "p-a",
    requestDigest: row("p-a", "req-1").requestDigest,
    economicsVersion: "econ-1",
    hash: "deadbeef",
  };
  const h = host({ v1: [row("p-a", "req-1")], econ: { "p-a": "econ-1" } });
  h.v2.push(bad);
  const res = m5Verify(h);
  assert.equal(res.ok, false);
  assert.ok(res.codes.includes(M5_FAIL.DIGEST_MISMATCH));
});

test("M5: collision between two distinct v1 rows blocks the switch", () => {
  const h = host({
    v1: [
      { profileId: "p-a", requestDigest: "abc", hash: "h1" },
      { profileId: "p-a", requestDigest: "abc", hash: "h2" },
    ],
    econ: { "p-a": "econ-1" },
  });
  const res = m5Switch(h);
  assert.equal(res.ok, false);
  assert.ok(res.codes.includes(M5_FAIL.REQUEST_HASH_COLLISION));
  assert.equal(h.switchedTo, null, "switch must NOT have flipped the pointer");
});

test("M5: identical duplicate v1 rows are benign (not a collision)", () => {
  // An idempotent resume re-reads the same row; two byte-identical v1 rows
  // (same identity, same hash) must NOT be treated as a collision.
  const h = host({
    v1: [
      { profileId: "p-a", requestDigest: "abc", hash: "h1" },
      { profileId: "p-a", requestDigest: "abc", hash: "h1" },
    ],
    econ: { "p-a": "econ-1" },
  });
  const res = migrateRequestHashV2(h);
  assert.equal(res.ok, true, "identical duplicates migrate idempotently");
  assert.deepEqual(res.codes, []);
  assert.equal(h.switchedTo, REQUEST_HASH_V2_VERSION);
});

test("M5: resume after crash — collision injected post-validation is caught at switch time", () => {
  const base = { profileId: "p-a", requestDigest: "abc", hash: "h1" };
  const h = host({
    v1: [base, { ...base, hash: "h2" }],
    econ: { "p-a": "econ-1" },
  });
  const hResumed = host({ v1: [base], econ: { "p-a": "econ-1" } });
  m5Copy(hResumed);
  assert.equal(m5Verify(hResumed).ok, true, "pre-crash validation passes");
  const res = m5Switch(h);
  assert.equal(res.ok, false);
  assert.ok(res.codes.includes(M5_FAIL.REQUEST_HASH_COLLISION));
});

test("M5: already on v2 refuses to switch again (NOT_ON_LEGACY)", () => {
  const h = host({ v1: [row("p-a", "req-1")], econ: { "p-a": "econ-1" }, active: REQUEST_HASH_V2_VERSION });
  const res = m5Switch(h);
  assert.equal(res.ok, false);
  assert.ok(res.codes.includes(M5_FAIL.NOT_ON_LEGACY));
});

test("M5: a row tied to an invalidated generation is skipped, the rest switch", () => {
  const h = host({
    v1: [row("p-a", "req-1"), row("p-b", "req-2")],
    econ: { "p-a": "econ-1", "p-b": "econ-9" },
    sessions: { "p-a": "s1", "p-b": "s1" },
    liveGen: { s1: 1n },
  });
  const res = migrateRequestHashV2(h);
  assert.equal(res.ok, true, "the surviving row still switches cleanly");
  assert.equal(h.v2.length, 1, "the dead-generation row was skipped");
  assert.equal(h.v2[0].profileId, "p-a");
});

test("M5: empty v1 set migrates as a clean no-op switch", () => {
  const h = host({ v1: [], econ: {} });
  const res = migrateRequestHashV2(h);
  assert.equal(res.ok, true);
  assert.equal(h.switchedTo, REQUEST_HASH_V2_VERSION);
});

test("M5: idempotent resume — re-copying over already-written rows emits nothing new", () => {
  const h = host({ v1: [row("p-a", "req-1")], econ: { "p-a": "econ-1" } });
  const first = m5Copy(h);
  const second = m5Copy(h);
  assert.equal(first.written.length, 1);
  assert.equal(second.written.length, 0, "no duplicate rows on resume");
});
