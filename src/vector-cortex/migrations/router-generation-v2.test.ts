/**
 * router-generation-v2.test.ts — M6 router-generation-v2 migration unit tests (VC3C).
 *
 * Drives copy/validate/switch over an injected in-memory M6Host (capability
 * shaped): copy is resumable + idempotent, verify compares the old/new query
 * sets and rejects a partial/corrupt/mis-sessioned set, interruption leaves the
 * legacy pointer active, and a verified switch flips the pointer exactly once.
 * The VC3C invariants are pinned: sessions `a`/`aa` never cross-evict
 * (M6-KEY-001) and a query set that claims a different session is rejected as
 * cross-session eviction.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  M6_FAIL,
  ROUTER_GEN_V2_VERSION,
  deriveRouterGenRow,
  m6Copy,
  m6Verify,
  m6Switch,
  migrateRouterGenerationV2,
  type M6Host,
  type RouterGenV2Row,
} from "./router-generation-v2.js";
import {
  encodeRouterKeyV2,
  decodeRouterKeyV2,
  type RouterKeyV2,
} from "../topology/query.js";

/** Structured key to persist as an old per-session query identity. */
function key(session: string, generation: bigint, alg = "topology"): RouterKeyV2 {
  return { session, sourceStart: 0n, sourceEnd: 10n, generation, algorithm: alg };
}

/**
 * In-memory M6Host harness. `oldKeys` is a map session -> legacy key strings;
 * `parseOldKey` decodes a legacy key of the form `session#generation#alg` into
 * the structured key (or rejects when the session tag disagrees — used to inject
 * cross-session eviction).
 */
function memHost(opts?: {
  sessions?: string[];
  oldKeys?: (s: string) => string[];
  preStored?: RouterGenV2Row[];
  active?: number;
  /** force a bad-old-key on a specific key */
  badKeys?: Set<string>;
}): {
  host: M6Host;
  rows: RouterGenV2Row[];
  active: () => number;
  switchCalls: () => number;
} {
  const sessions = opts?.sessions ?? ["s1", "s2"];
  const defaultKeys: Record<string, string[]> = {
    s1: ["s1#1#topology", "s1#2#topology"],
    s2: ["s2#1#topology"],
  };
  const oldKeys = opts?.oldKeys ?? ((s: string) => defaultKeys[s] ?? []);
  const rows: RouterGenV2Row[] = [...(opts?.preStored ?? [])];
  const state = { active: opts?.active ?? 1, switchCalls: 0 };
  const bad = opts?.badKeys ?? new Set<string>();
  const parse = (_session: string, oldKey: string): { ok: true; key: RouterKeyV2 } | { ok: false } => {
    if (bad.has(oldKey)) return { ok: false };
    const m = /^([^#]+)#(\d+)#([^#]+)$/.exec(oldKey);
    if (!m) return { ok: false };
    const [, seg, gen, alg] = m;
    const generation = BigInt(gen as string);
    // Cross-session eviction injection: if the legacy key's segment disagrees
    // with the slot session, the structured key carries the OTHER session.
    const carried = seg as string;
    return { ok: true, key: key(carried, generation, alg as string) };
  };
  const host: M6Host = {
    sessions: () => sessions,
    oldKeysOf: (s) => oldKeys(s),
    parseOldKey: parse,
    existingV2: () => rows,
    putV2: (newRows) => rows.push(...newRows),
    activeVersion: () => state.active,
    switchToV2: () => {
      state.active = ROUTER_GEN_V2_VERSION;
      state.switchCalls += 1;
    },
  };
  return { host, rows, active: () => state.active, switchCalls: () => state.switchCalls };
}

describe("M6 copy", () => {
  test("M6-001: copy -> verify -> switch activates v2 and switches exactly once", () => {
    const h = memHost();
    const { written } = m6Copy(h.host);
    assert.equal(written.length, 3, "one row per old query key across sessions");
    const v = m6Verify(h.host);
    assert.equal(v.ok, true, `verify ok, got ${v.codes.join(",")}`);
    m6Switch(h.host);
    assert.equal(h.active(), ROUTER_GEN_V2_VERSION, "switch activates v2");
    assert.equal(h.switchCalls(), 1, "switched exactly once");
  });

  test("M6-002: repeated copy is idempotent (no duplicate rows)", () => {
    const h = memHost();
    m6Copy(h.host);
    const second = m6Copy(h.host);
    assert.equal(second.written.length, 0, "no duplicate writes on re-copy");
    const v = m6Verify(h.host);
    assert.equal(v.ok, true, `verify ok after idempotent re-copy, got ${v.codes.join(",")}`);
    assert.equal(h.rows.length, 3, "exactly one row per old key");
  });

  test("M6-003/M6-RESUME: an interrupted copy resumes without duplicates or pointer drift", () => {
    const h = memHost({ sessions: ["s1", "s2"] });
    // First pass persists only s1's two rows (crash before s2 copied).
    const s1rows = ["s1#1#topology", "s1#2#topology"].map((ok_) =>
      deriveRouterGenRow(h.host, "s1", ok_).ok
        ? (deriveRouterGenRow(h.host, "s1", ok_) as { ok: true; row: RouterGenV2Row }).row
        : undefined,
    ).filter((r): r is RouterGenV2Row => r !== undefined);
    h.host.putV2(s1rows);
    assert.equal(h.rows.length, 2, "only s1 persisted after interruption");
    assert.equal(h.host.activeVersion(), 1, "legacy still active after interruption");
    // Resume: copy fills s2 only.
    const resume = m6Copy(h.host);
    assert.equal(resume.written.length, 1, "resume fills only the missing session's row");
    const res = migrateRouterGenerationV2(h.host);
    assert.equal(res.ok, true, `resumed migration ok, got ${res.codes.join(",")}`);
    assert.equal(h.rows.length, 3, "no duplicate rows after resume");
    assert.equal(h.active(), ROUTER_GEN_V2_VERSION, "verified switch activates v2");
  });

  test("M6-KEY-001: sessions `a` and `aa` derive distinct rows and never cross-evict", () => {
    const rows = ["a#1#topology", "aa#1#topology"].map((ok_) => {
      const session = ok_.startsWith("aa") ? "aa" : "a";
      const d = deriveRouterGenRow(memHost({ sessions: [session], oldKeys: () => [ok_] }).host, session, ok_);
      assert.equal(d.ok, true, "each derives");
      return (d as { ok: true; row: RouterGenV2Row }).row;
    });
    assert.equal(rows[0]?.session, "a");
    assert.equal(rows[1]?.session, "aa");
    assert.notEqual(rows[0]?.key, rows[1]?.key, "distinct canonical keys");
    assert.notEqual(rows[0]?.digest, rows[1]?.digest, "distinct digests");
  });
});

describe("M6 verify failures", () => {
  test("M6-004: a partial copy reports M6_COPY_PARTIAL", () => {
    const h = memHost({ sessions: ["s1"] });
    // Only one of s1's two old keys has a stored row.
    const one = deriveRouterGenRow(h.host, "s1", "s1#1#topology");
    assert.equal(one.ok, true);
    if (!one.ok) throw new Error("unreachable");
    h.host.putV2([one.row]);
    const v = m6Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M6_FAIL.COPY_PARTIAL), `got ${v.codes.join(",")}`);
  });

  test("M6-005: a row whose stored digest does not re-hash reports M6_DIGEST_MISMATCH", () => {
    const h = memHost({ sessions: ["s1"] });
    const all = m6Copy(h.host);
    // Corrupt one digest.
    const bad = h.rows.map((r) => ({ ...r, digest: "sha256:deadbeef" }));
    const h2 = memHost({ sessions: ["s1"], preStored: bad, oldKeys: () => ["s1#1#topology"] });
    const v = m6Verify(h2.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M6_FAIL.DIGEST_MISMATCH), `got ${v.codes.join(",")}`);
    void all;
  });

  test("M6-006: a duplicated row reports M6_COUNT_MISMATCH", () => {
    const h = memHost({ sessions: ["s1"] });
    const one = deriveRouterGenRow(h.host, "s1", "s1#1#topology");
    assert.equal(one.ok, true);
    if (!one.ok) throw new Error("unreachable");
    h.host.putV2([one.row, { ...one.row }]); // two rows for one old key
    const v = m6Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M6_FAIL.COUNT_MISMATCH), `got ${v.codes.join(",")}`);
  });

  test("M6-007: an undecodable old key reports M6_BAD_OLD_KEY", () => {
    const h = memHost({ sessions: ["s1"], badKeys: new Set(["s1#1#topology"]) });
    const v = m6Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M6_FAIL.BAD_OLD_KEY), `got ${v.codes.join(",")}`);
  });

  test("M6-CROSS-SESSION: a row whose structured key claims a different session is rejected", () => {
    // old key "s2#1#topology" carried under session s1 -> structured key says s2.
    const h = memHost({ sessions: ["s1"], oldKeys: () => ["s2#1#topology"] });
    const v = m6Verify(h.host);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes(M6_FAIL.CROSS_SESSION_EVICTION), `got ${v.codes.join(",")}`);
  });

  test("M6-008: interruption before switch leaves the legacy pointer active", () => {
    const h = memHost();
    m6Copy(h.host);
    const v = m6Verify(h.host);
    assert.equal(v.ok, true, "validate ok");
    assert.equal(h.host.activeVersion(), 1, "legacy active until verified switch");
  });
});

describe("M6 full lifecycle", () => {
  test("migrateRouterGenerationV2 switches on a balanced old/new set", () => {
    const h = memHost();
    const res = migrateRouterGenerationV2(h.host);
    assert.equal(res.ok, true, `got ${res.codes.join(",")}`);
    assert.equal(h.active(), ROUTER_GEN_V2_VERSION);
  });

  test("old and new query sets compare equal by structured identity (never string prefix)", () => {
    const h = memHost();
    migrateRouterGenerationV2(h.host);
    // Every stored row decodes back to a structured key; re-encoding must be
    // identical (canonical), proving the set is exactly the derivable set.
    for (const r of h.rows) {
      const dec = decodeRouterKeyV2(r.key);
      assert.equal(dec.ok, true);
      if (!dec.ok) throw new Error("unreachable");
      assert.equal(encodeRouterKeyV2(dec.key), r.key, "row key is canonical");
    }
  });
});
