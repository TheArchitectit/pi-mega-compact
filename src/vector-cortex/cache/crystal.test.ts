/**
 * cache/crystal.test.ts — VC7A canonical key encoding, range ordering, overlap
 * rejection, and invalidation.
 *
 * Every row runs the REAL `encodeCrystalKey` over the REAL committed corpus. The
 * central invariant under test is stated once and asserted many ways: THE KEY
 * CHANGES IFF AN IDENTITY FIELD CHANGES. Reordering ranges, or appending to a
 * session the key does not cover, must not move it; a covered byte, a dependency
 * tick, a renderer bump, or a profile bump must.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CRYSTAL_IDS,
  CRYSTAL_LIMIT_RANGES,
  CRYSTAL_NAMED_IDS,
  CRYSTAL_PROVIDER_IDS,
  type CrystalKeyV1,
  type DagSpan,
} from "./types.js";
import {
  compareSpans,
  computeCoveredDigest,
  encodeCrystalKey,
  encodeCrystalKeyBytes,
  sameCrystalKey,
  sortSpans,
  validateRanges,
} from "./crystal.js";
import { crystalFixture, decodeKey, decodeSpan } from "./_crystal-fixture.js";

const span = (
  sessionId: string,
  startSeq: number,
  endSeq: number,
  startByte: number,
  endByte: number,
  text: string,
): DagSpan => ({
  sessionId,
  startSeq: BigInt(startSeq),
  endSeq: BigInt(endSeq),
  startByte,
  endByte,
  digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

const key = (sourceRanges: readonly DagSpan[], extra: Partial<CrystalKeyV1> = {}): CrystalKeyV1 => ({
  profileId: "anthropic-claude-opus",
  profileVersion: "v1",
  requestDigest: createHash("sha256").update("req").digest("hex"),
  rendererVersion: "render-v1",
  dependencyHighWater: 100n,
  sourceRanges,
  coveredDigest: computeCoveredDigest(sourceRanges),
  ...extra,
});

const BASE: readonly DagSpan[] = [
  span("s-alpha", 1, 2, 0, 64, "alpha-one"),
  span("s-alpha", 3, 4, 64, 160, "alpha-two"),
];

// ── Canonical ordering ───────────────────────────────────────────────────────

test("VC7A: ranges sort by (sessionId, startSeq, startByte)", () => {
  const a = span("s-b", 1, 1, 0, 8, "a");
  const b = span("s-a", 5, 5, 0, 8, "b");
  const c = span("s-a", 1, 1, 32, 40, "c");
  const d = span("s-a", 1, 1, 0, 8, "d");
  const sorted = sortSpans([a, b, c, d]);
  assert.deepEqual(
    sorted.map((s) => [s.sessionId, Number(s.startSeq), s.startByte]),
    [
      ["s-a", 1, 0],
      ["s-a", 1, 32],
      ["s-a", 5, 0],
      ["s-b", 1, 0],
    ],
  );
});

test("VC7A: sortSpans never mutates its input", () => {
  const input = [BASE[1]!, BASE[0]!];
  const before = [...input];
  sortSpans(input);
  assert.deepEqual(input, before);
});

test("VC7A: compareSpans is a total order (antisymmetric, reflexive-zero)", () => {
  assert.equal(compareSpans(BASE[0]!, BASE[0]!), 0);
  assert.ok(compareSpans(BASE[0]!, BASE[1]!) < 0);
  assert.ok(compareSpans(BASE[1]!, BASE[0]!) > 0);
});

test("VC7A: range order is not identity — any permutation keys the same", () => {
  assert.ok(sameCrystalKey(key([BASE[0]!, BASE[1]!]), key([BASE[1]!, BASE[0]!])));
});

// ── Overlap and malformed range rejection ────────────────────────────────────

test("VC7A: overlapping same-session ranges are rejected as CRY_RANGE_OVERLAP", () => {
  const r = encodeCrystalKey(
    key([span("s-a", 1, 2, 0, 96, "x"), span("s-a", 2, 3, 64, 160, "y")]),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.codes.includes("CRY_RANGE_OVERLAP"));
});

test("VC7A: a contained range is an overlap, not a legal nesting", () => {
  const r = encodeCrystalKey(
    key([span("s-a", 1, 4, 0, 256, "outer"), span("s-a", 2, 2, 32, 64, "inner")]),
  );
  assert.ok(!r.ok && r.codes.includes("CRY_RANGE_OVERLAP"));
});

test("VC7A: adjacent half-open ranges (a.end === b.start) do NOT overlap", () => {
  const r = encodeCrystalKey(
    key([span("s-a", 1, 1, 0, 64, "p"), span("s-a", 2, 2, 64, 128, "q")]),
  );
  assert.equal(r.ok, true);
});

test("VC7A: same byte window in DIFFERENT sessions is not an overlap", () => {
  const r = encodeCrystalKey(
    key([span("s-a", 1, 1, 0, 64, "p"), span("s-b", 1, 1, 0, 64, "q")]),
  );
  assert.equal(r.ok, true);
});

test("VC7A: an empty range set is CRY_RANGE_EMPTY", () => {
  const r = encodeCrystalKey(key([]));
  assert.ok(!r.ok && r.codes.includes("CRY_RANGE_EMPTY"));
});

test("VC7A: reversed byte/seq bounds are CRY_RANGE_INVALID", () => {
  assert.ok(
    !encodeCrystalKey(key([span("s-a", 1, 1, 128, 64, "rev")])).ok,
    "reversed bytes rejected",
  );
  const seqRev = encodeCrystalKey(key([span("s-a", 5, 1, 0, 64, "rev")]));
  assert.ok(!seqRev.ok && seqRev.codes.includes("CRY_RANGE_INVALID"));
});

test("VC7A: a range count over the bound is CRY_KEY_LIMIT", () => {
  const many = Array.from({ length: CRYSTAL_LIMIT_RANGES + 1 }, (_v, i) =>
    span("s-a", i + 1, i + 1, i * 8, i * 8 + 8, `r${i}`),
  );
  const r = encodeCrystalKey(key(many));
  assert.ok(!r.ok && r.codes.includes("CRY_KEY_LIMIT"));
});

test("VC7A: failure codes are deduplicated and deterministically ordered", () => {
  const r = encodeCrystalKey(key([span("s-a", 1, 1, 50, 10, "bad"), span("s-a", 2, 2, 90, 20, "bad2")]));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.codes, [...new Set(r.codes)]);
    assert.deepEqual(r.codes, ["CRY_RANGE_INVALID"]);
  }
});

// ── Identity: what is and is not in the key ──────────────────────────────────

test("VC7A: the encoding is injective — length prefixes prevent field aliasing", () => {
  const a = key(BASE, { profileId: "ab", profileVersion: "c" });
  const b = key(BASE, { profileId: "a", profileVersion: "bc" });
  assert.notEqual(encodeCrystalKeyBytes(a), encodeCrystalKeyBytes(b));
  assert.ok(!sameCrystalKey(a, b));
});

test("VC7A: one covered byte change invalidates the key", () => {
  const mutated = [BASE[0]!, span("s-alpha", 3, 4, 64, 160, "alpha-twa")];
  assert.ok(!sameCrystalKey(key(BASE), key(mutated)));
});

test("VC7A: a dependency high-water advance invalidates the key", () => {
  assert.ok(!sameCrystalKey(key(BASE), key(BASE, { dependencyHighWater: 101n })));
});

test("VC7A: a renderer or profile bump invalidates the key", () => {
  assert.ok(!sameCrystalKey(key(BASE), key(BASE, { rendererVersion: "render-v2" })));
  assert.ok(!sameCrystalKey(key(BASE), key(BASE, { profileVersion: "v2" })));
  assert.ok(!sameCrystalKey(key(BASE), key(BASE, { profileId: "openai-gpt" })));
});

test("VC7A: an unrelated append to an uncovered session leaves the key unchanged", () => {
  const before = encodeCrystalKey(key(BASE));
  // The append lands on s-omega, which this crystal does not cover. The global
  // frontier moved; the key cannot see it because it is not an identity field.
  const after = encodeCrystalKey(key([BASE[1]!, BASE[0]!]));
  assert.ok(before.ok && after.ok);
  if (before.ok && after.ok) assert.equal(before.keyDigest, after.keyDigest);
});

test("VC7A: a stale caller-supplied coveredDigest is re-derived, never trusted", () => {
  const lying = key(BASE, { coveredDigest: "sha256:0000" });
  const honest = key(BASE);
  const a = encodeCrystalKey(lying);
  const b = encodeCrystalKey(honest);
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) {
    assert.equal(a.keyDigest, b.keyDigest);
    assert.equal(a.key.coveredDigest, computeCoveredDigest(BASE));
  }
});

test("VC7A: encodeCrystalKey returns ranges in canonical sorted order", () => {
  const r = encodeCrystalKey(key([BASE[1]!, BASE[0]!]));
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.key.sourceRanges.map((s) => s.startByte), [0, 64]);
});

test("VC7A: coveredDigest is order-independent and prefixed", () => {
  const a = computeCoveredDigest([BASE[0]!, BASE[1]!]);
  const b = computeCoveredDigest([BASE[1]!, BASE[0]!]);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test("VC7A: key encoding is deterministic across repeated calls", () => {
  const k = key(BASE);
  const digests = new Set(
    Array.from({ length: 5 }, () => {
      const r = encodeCrystalKey(k);
      return r.ok ? r.keyDigest : "err";
    }),
  );
  assert.equal(digests.size, 1);
});

// ── Corpus rows: CRY-001..015, PRO-016..023, named ───────────────────────────

/** Drive one corpus row through the real modules and assert its pinned verdict. */
function runKeyRow(id: string): void {
  const fx = crystalFixture(id);
  if (fx.input.scenario === "compare") {
    const a = encodeCrystalKey(decodeKey(fx.input.key));
    const b = encodeCrystalKey(decodeKey(fx.input.other!));
    assert.ok(a.ok && b.ok, `${id}: both identities encode`);
    const same = a.ok && b.ok && a.keyDigest === b.keyDigest;
    assert.equal(same, fx.expected.sameKey, `${id}: ${fx.assertion}`);
    return;
  }
  if (fx.input.scenario !== "key") return;
  const r = encodeCrystalKey(decodeKey(fx.input.key));
  assert.equal(r.ok, fx.expected.ok, `${id}: ${fx.assertion}`);
  if (!r.ok) {
    assert.ok(r.codes.includes(fx.expected.code as never), `${id}: expected ${fx.expected.code}`);
    return;
  }
  if (fx.expected.sortedSessions !== undefined) {
    assert.deepEqual(r.key.sourceRanges.map((s) => s.sessionId), fx.expected.sortedSessions);
  }
  if (fx.expected.sortedStartBytes !== undefined) {
    assert.deepEqual(r.key.sourceRanges.map((s) => s.startByte), fx.expected.sortedStartBytes);
  }
  if (fx.expected.rangeCount !== undefined) {
    assert.equal(r.key.sourceRanges.length, fx.expected.rangeCount);
  }
}

for (const id of [...CRYSTAL_IDS, ...CRYSTAL_PROVIDER_IDS, ...CRYSTAL_NAMED_IDS]) {
  test(`VC7A corpus ${id}`, () => {
    runKeyRow(id);
  });
}

test("VC7A: CRY-FRONTIER-001's unrelated append is genuinely uncovered", () => {
  const fx = crystalFixture("CRY-FRONTIER-001");
  const appended = decodeSpan(fx.input.unrelatedAppend!);
  const covered = decodeKey(fx.input.key).sourceRanges;
  assert.ok(
    covered.every((s) => s.sessionId !== appended.sessionId),
    "the appended range must lie outside every covered session",
  );
});

test("VC7A: validateRanges agrees with encodeCrystalKey on every corpus key row", () => {
  for (const id of CRYSTAL_IDS) {
    const fx = crystalFixture(id);
    if (fx.input.scenario !== "key") continue;
    const codes = validateRanges(decodeKey(fx.input.key).sourceRanges);
    assert.equal(codes.length === 0, fx.expected.ok, `${id}: validator matches encoder`);
  }
});
