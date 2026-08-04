/**
 * minhash-v2.test.ts — M4 MinHashV2 migration unit tests (VC1C).
 *
 * Drives copy/validate/switch over an injected in-memory M4Host (capability
 * shaped, no SQLite/network): backfill is resumable and idempotent, verify
 * rejects partial/count/digest/version mismatches, interruption leaves v1
 * active, and a verified switch flips the active pointer exactly once.
 * Cross-version compare is always rejected with MINHASH_VERSION_MISMATCH.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  M4_FAIL,
  computeV2Row,
  m4Backfill,
  m4Verify,
  m4Switch,
  migrateMinhashV2,
  crossVersionError,
  type M4Host,
  type V2SignatureRow,
} from "./minhash-v2.js";
import { MINHASH_VERSION } from "../../dedup/l1-minhash-v2.js";

/** In-memory M4Host harness. */
function memHost(opts?: {
  ids?: string[];
  textFor?: (id: string) => string;
  sessionFor?: (id: string) => string;
  preStored?: V2SignatureRow[];
  active?: number;
}): {
  host: M4Host;
  rows: V2SignatureRow[];
  active: () => number;
  switchCalls: () => number;
} {
  const ids = opts?.ids ?? ["c1", "c2", "c3"];
  const textFor = opts?.textFor ?? ((id: string) => `source-of-${id}`);
  const sessionFor = opts?.sessionFor ?? (() => "s1");
  const rows: V2SignatureRow[] = [...(opts?.preStored ?? [])];
  const state = { active: opts?.active ?? 1, switchCalls: 0 };
  const host: M4Host = {
    v1CheckpointIds: () => ids,
    sessionOf: (id) => sessionFor(id),
    sourceOf: (id) => textFor(id),
    storedV2: () => rows,
    activeVersion: () => state.active,
    putV2: (newRows) => {
      // Append without dedup: backfill avoids re-writing known ids via storedV2,
      // so idempotency holds while duplicate rows can be injected for the
      // duplicate-row failure case (M4-006).
      rows.push(...newRows);
    },
    switchToV2: () => {
      state.active = MINHASH_VERSION;
      state.switchCalls += 1;
    },
  };
  return { host, rows, active: () => state.active, switchCalls: () => state.switchCalls };
}
describe("M4 backfill", () => {
  test("M4-001: backfill writes a v2 row per checkpoint, verify ok, switch activates v2", () => {
    const h = memHost();
    const delta = m4Backfill(h.host);
    assert.equal(delta.length, 3);
    const v = m4Verify(h.host);
    assert.equal(v.ok, true, `verify ok, got ${v.codes.join(",")}`);
    m4Switch(h.host);
    assert.equal(h.active(), 2, "switch activates v2");
    assert.equal(h.switchCalls(), 1, "switched exactly once");
  });

  test("M4-002/M4-008: repeated backfill is idempotent (no duplicate rows)", () => {
    const h = memHost({ ids: ["c1", "c2"] });
    m4Backfill(h.host);
    const delta2 = m4Backfill(h.host); // resumable: already backfilled
    assert.equal(delta2.length, 0, "no duplicate writes on re-backfill");
    const v = m4Verify(h.host);
    assert.equal(v.ok, true, "verify ok after idempotent re-backfill");
    assert.equal(h.rows.length, 2, "exactly one row per checkpoint");
    const counts = new Map<string, number>();
    for (const r of h.rows) counts.set(r.checkpointId, (counts.get(r.checkpointId) ?? 0) + 1);
    for (const id of ["c1", "c2"]) assert.equal(counts.get(id), 1, `exactly one ${id}`);
  });

  test("M4-RESUME: an interrupted backfill resumes with no duplicate signatures", () => {
    const h = memHost({ ids: ["c1", "c2"] });
    // First pass writes only c1 (crash before c2 backfilled).
    const c1 = computeV2Row(h.host, "c1");
    h.host.putV2([c1]);
    assert.equal(h.rows.length, 1, "only c1 persisted after interruption");
    assert.equal(h.host.activeVersion(), 1, "v1 still active after interruption");
    // Resume: backfill fills c2 only, does not duplicate c1.
    const delta = m4Backfill(h.host);
    assert.deepEqual(delta.map((r) => r.checkpointId), ["c2"], "resume fills only the missing id");
    const res = migrateMinhashV2(h.host);
    assert.equal(res.ok, true, `resumed migration ok, got ${res.codes.join(",")}`);
    assert.equal(h.rows.length, 2, "no duplicate signatures after resume");
    assert.equal(h.host.activeVersion(), 2, "verified switch activates v2");
  });

  test("M4-003: interruption before switch leaves v1 active (old authority retained)", () => {
    const h = memHost();
    m4Backfill(h.host);
    const v = m4Verify(h.host);
    assert.equal(v.ok, true, "validate ok");
    // Simulated crash: caller returns before m4Switch; pointer stays v1.
    assert.equal(h.host.activeVersion(), 1, "v1 active until verified switch");
  });
});

describe("M4 verify failures", () => {
  test("M4-004: a partial backfill reports M4_BACKFILL_PARTIAL", () => {
    const h = memHost({ ids: ["c1", "c2"] });
    const c1 = computeV2Row(h.host, "c1");
    h.host.putV2([c1]); // only c1 present, c2 missing
    const v = m4Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M4_FAIL.BACKFILL_PARTIAL), `got ${v.codes.join(",")}`);
  });

  test("M4-005: a row whose digest does not re-hash reports M4_DIGEST_MISMATCH", () => {
    const h = memHost({ ids: ["c1"] });
    const c1 = computeV2Row(h.host, "c1");
    h.host.putV2([{ ...c1, digest: "sha256:deadbeef" }]);
    const v = m4Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M4_FAIL.DIGEST_MISMATCH), `got ${v.codes.join(",")}`);
  });

  test("M4-006: a duplicated v2 row reports M4_COUNT_MISMATCH", () => {
    const h = memHost({ ids: ["c1"] });
    const c1 = computeV2Row(h.host, "c1");
    h.host.putV2([c1, { ...c1 }]); // two rows for one checkpoint
    const v = m4Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M4_FAIL.COUNT_MISMATCH), `got ${v.codes.join(",")}`);
  });

  test("M4-007: a row at the wrong version reports MINHASH_VERSION_MISMATCH", () => {
    const h = memHost({ ids: ["c1"] });
    const c1 = computeV2Row(h.host, "c1");
    h.host.putV2([{ ...c1, version: 1 }]);
    const v = m4Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M4_FAIL.VERSION_MISMATCH), `got ${v.codes.join(",")}`);
  });
});

describe("M4 cross-version rejection", () => {
  test("cross-version compare always returns MINHASH_VERSION_MISMATCH", () => {
    assert.equal(crossVersionError(), M4_FAIL.VERSION_MISMATCH);
    assert.equal(crossVersionError(), "MINHASH_VERSION_MISMATCH");
  });
});

describe("computeV2Row", () => {
  test("a v2 row carries the frozen version, 2048-byte signature, 64 buckets", () => {
    const row = computeV2Row(memHost({ ids: ["c1"] }).host, "c1");
    assert.equal(row.version, MINHASH_VERSION);
    assert.equal(row.signatureBytes.length, 2048);
    assert.equal(row.buckets.length, 64);
    assert.ok(row.digest.startsWith("sha256:"), "digest is sha256:<hex>");
    assert.equal(row.checkpointId, "c1");
  });
});
