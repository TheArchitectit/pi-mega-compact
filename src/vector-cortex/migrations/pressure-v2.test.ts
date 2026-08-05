/**
 * migrations/pressure-v2.test.ts — M7 pressure-v2 migration tests.
 *
 * Covers copy/validate/switch, canonical-label-only mapping, unknown-label
 * rejection, resume idempotence, and the sprint's headline failure injection:
 * kill after the copy, insert an unknown legacy pressure, and confirm the
 * resumed run returns M7_PRESSURE_UNKNOWN while KEEPING the old pointer.
 *
 * Uses the real production module against an in-memory host — no mocks of the
 * migration itself.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  M7_FAIL,
  PRESSURE_LEGACY_VERSION,
  PRESSURE_V2_VERSION,
  derivePressureDigest,
  m7Copy,
  m7Switch,
  m7Verify,
  mapPressureRow,
  migratePressureV2,
} from "./pressure-v2.js";
import type {
  M7Host,
  PressureV1Row,
  PressureV2Row,
} from "./pressure-v2.js";

/** A mutable in-memory M7 host — the real store shape, no mocking library. */
function makeHost(v1: PressureV1Row[]): {
  host: M7Host;
  state: { v2: PressureV2Row[]; active: number; writes: number };
} {
  const state = { v2: [] as PressureV2Row[], active: PRESSURE_LEGACY_VERSION, writes: 0 };
  const host: M7Host = {
    v1Rows: () => v1,
    existingV2: () => state.v2,
    putV2: (rows) => {
      state.writes += 1;
      for (const row of rows) {
        const i = state.v2.findIndex(
          (r) => r.sessionId === row.sessionId && r.effectiveSeq === row.effectiveSeq,
        );
        if (i >= 0) state.v2[i] = row;
        else state.v2.push(row);
      }
    },
    activeVersion: () => state.active,
    switchToV2: () => {
      state.active = PRESSURE_V2_VERSION;
    },
  };
  return { host, state };
}

function row(sessionId: string, label: string, effectiveSeq: number): PressureV1Row {
  return { sessionId, label, effectiveSeq, ts: "2026-01-01T00:00:00Z" };
}

const CANONICAL: PressureV1Row[] = [
  row("sess-1", "low", 1),
  row("sess-1", "medium", 2),
  row("sess-2", "high", 1),
  row("sess-3", "ultra", 1),
  row("sess-4", "mega", 1),
];

describe("M7 label mapping", () => {
  test("all five canonical labels map", () => {
    for (const label of ["low", "medium", "high", "ultra", "mega"]) {
      const mapped = mapPressureRow(row("s", label, 1));
      assert.equal(mapped.level, label);
      assert.match(mapped.digest, /^[0-9a-f]{64}$/);
    }
  });

  test("M7-PRESSURE-003: an unknown label rejects the migration row", () => {
    for (const bad of ["extreme", "critical", "LOW", "", "none"]) {
      try {
        mapPressureRow(row("s", bad, 1));
        assert.fail(`expected ${bad} to reject`);
      } catch (err) {
        assert.equal((err as { code?: string }).code, M7_FAIL.PRESSURE_UNKNOWN);
      }
    }
  });

  test("the digest re-derives from the row's own fields", () => {
    const mapped = mapPressureRow(row("sess-1", "high", 7));
    assert.equal(
      mapped.digest,
      derivePressureDigest("sess-1", "high", 7, "2026-01-01T00:00:00Z"),
    );
  });

  test("the digest is field-injective (no aliasing across boundaries)", () => {
    // Length-prefixed framing: "ab"+"c" must not collide with "a"+"bc".
    assert.notEqual(
      derivePressureDigest("ab", "low", 1, "t"),
      derivePressureDigest("a", "low", 1, "t"),
    );
    assert.notEqual(
      derivePressureDigest("s", "low", 1, "t"),
      derivePressureDigest("s", "low", 11, "t"),
    );
  });
});

describe("M7 copy", () => {
  test("copies every canonical legacy row", () => {
    const { host, state } = makeHost([...CANONICAL]);
    const { written } = m7Copy(host);
    assert.equal(written.length, CANONICAL.length);
    assert.equal(state.v2.length, CANONICAL.length);
  });

  test("copy is resumable: a second run writes nothing new", () => {
    const { host, state } = makeHost([...CANONICAL]);
    m7Copy(host);
    const writesAfterFirst = state.writes;
    const { written } = m7Copy(host);
    assert.equal(written.length, 0, "no duplicate rows on resume");
    assert.equal(state.writes, writesAfterFirst, "no redundant write call");
    assert.equal(state.v2.length, CANONICAL.length);
  });

  test("an interrupted copy resumes and completes the remainder", () => {
    const { host, state } = makeHost([...CANONICAL]);
    // Simulate a crash after only the first two rows were persisted.
    state.v2 = [mapPressureRow(CANONICAL[0]), mapPressureRow(CANONICAL[1])];
    const { written } = m7Copy(host);
    assert.equal(written.length, 3, "only the missing rows are written");
    assert.equal(state.v2.length, CANONICAL.length);
  });

  test("an unknown label aborts the copy before any write", () => {
    const { host, state } = makeHost([row("s", "extreme", 1)]);
    try {
      m7Copy(host);
      assert.fail("expected the copy to reject");
    } catch (err) {
      assert.equal((err as { code?: string }).code, M7_FAIL.PRESSURE_UNKNOWN);
    }
    assert.equal(state.v2.length, 0, "nothing was written");
  });

  test("the copy never mutates the legacy rows", () => {
    const v1 = [...CANONICAL];
    const snapshot = JSON.stringify(v1);
    const { host } = makeHost(v1);
    m7Copy(host);
    assert.equal(JSON.stringify(v1), snapshot);
  });
});

describe("M7 verify", () => {
  test("a complete, canonical copy verifies clean", () => {
    const { host } = makeHost([...CANONICAL]);
    m7Copy(host);
    assert.deepEqual(m7Verify(host), { ok: true, codes: [] });
  });

  test("a partial copy reports M7_COPY_PARTIAL", () => {
    const { host, state } = makeHost([...CANONICAL]);
    m7Copy(host);
    state.v2 = state.v2.slice(0, 2);
    const result = m7Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M7_FAIL.COPY_PARTIAL));
  });

  test("a tampered digest reports M7_DIGEST_MISMATCH", () => {
    const { host, state } = makeHost([...CANONICAL]);
    m7Copy(host);
    state.v2[0] = { ...state.v2[0], digest: "0".repeat(64) };
    const result = m7Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M7_FAIL.DIGEST_MISMATCH));
  });

  test("a duplicated row reports M7_COUNT_MISMATCH", () => {
    const { host, state } = makeHost([...CANONICAL]);
    m7Copy(host);
    state.v2.push({ ...state.v2[0] });
    const result = m7Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M7_FAIL.COUNT_MISMATCH));
  });

  test("an unknown legacy label reports M7_PRESSURE_UNKNOWN", () => {
    const { host } = makeHost([...CANONICAL, row("sess-9", "extreme", 1)]);
    const result = m7Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M7_FAIL.PRESSURE_UNKNOWN));
  });

  test("codes are deduplicated", () => {
    const { host } = makeHost([row("a", "bad", 1), row("b", "worse", 1)]);
    const result = m7Verify(host);
    const unknowns = result.codes.filter((c) => c === M7_FAIL.PRESSURE_UNKNOWN);
    assert.equal(unknowns.length, 1, "one code per distinct failure");
  });
});

describe("M7 switch", () => {
  test("a clean migration switches the pointer to v2", () => {
    const { host, state } = makeHost([...CANONICAL]);
    const result = migratePressureV2(host);
    assert.deepEqual(result, { ok: true, codes: [] });
    assert.equal(state.active, PRESSURE_V2_VERSION);
  });

  test("switching when already on v2 reports M7_NOT_ON_LEGACY", () => {
    const { host, state } = makeHost([...CANONICAL]);
    migratePressureV2(host);
    const again = m7Switch(host);
    assert.equal(again.ok, false);
    assert.deepEqual(again.codes, [M7_FAIL.NOT_ON_LEGACY]);
    assert.equal(state.active, PRESSURE_V2_VERSION, "pointer is unchanged");
  });

  test("a failed validation leaves the pointer on legacy", () => {
    const { host, state } = makeHost([...CANONICAL]);
    m7Copy(host);
    state.v2 = state.v2.slice(0, 1);
    const result = m7Switch(host);
    assert.equal(result.ok, false);
    assert.equal(state.active, PRESSURE_LEGACY_VERSION, "old pointer survives");
  });

  test("FAILURE INJECTION: unknown pressure inserted AFTER the copy keeps the old pointer", () => {
    // The sprint's unique failure injection. The copy completes cleanly, then
    // an unknown legacy row appears (a late writer, a rolled-back deploy). The
    // resumed switch MUST re-read the host, detect it, and refuse.
    const v1: PressureV1Row[] = [...CANONICAL];
    const { host, state } = makeHost(v1);

    m7Copy(host);
    assert.equal(state.v2.length, CANONICAL.length, "copy completed");
    assert.equal(m7Verify(host).ok, true, "and verified clean at that moment");

    // Kill + inject: an uncanonical legacy pressure lands post-copy.
    v1.push(row("sess-late", "catastrophic", 1));

    const result = m7Switch(host);
    assert.equal(result.ok, false);
    assert.ok(
      result.codes.includes(M7_FAIL.PRESSURE_UNKNOWN),
      "the resumed run re-detects the injected label",
    );
    assert.equal(
      state.active,
      PRESSURE_LEGACY_VERSION,
      "the old pointer is KEPT — this is the whole point of the injection",
    );
  });

  test("the full migration reports M7_PRESSURE_UNKNOWN for a bad label", () => {
    const { host, state } = makeHost([...CANONICAL, row("s", "nope", 1)]);
    const result = migratePressureV2(host);
    assert.equal(result.ok, false);
    assert.deepEqual(result.codes, [M7_FAIL.PRESSURE_UNKNOWN]);
    assert.equal(state.active, PRESSURE_LEGACY_VERSION);
  });

  test("the migration is idempotent across a resumed run", () => {
    const { host, state } = makeHost([...CANONICAL]);
    m7Copy(host);
    const rowsAfterCopy = JSON.stringify(state.v2);
    const result = migratePressureV2(host);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(state.v2), rowsAfterCopy, "rows are unchanged");
    assert.equal(state.active, PRESSURE_V2_VERSION);
  });

  test("an empty legacy store migrates cleanly", () => {
    const { host, state } = makeHost([]);
    const result = migratePressureV2(host);
    assert.equal(result.ok, true);
    assert.equal(state.active, PRESSURE_V2_VERSION);
  });
});
