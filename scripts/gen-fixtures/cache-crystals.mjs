// VC7A frozen range crystal fixtures
// (`conformance/vector-cortex/v2/cache-crystals/`).
//
// Owner VC7A (encodeCrystalKey / validateRanges / CrystalStore). Each fixture
// carries one or two crystal IDENTITIES (`input.key`, optional `input.other`)
// plus, for store rows, the bytes to write. The acceptance test feeds these
// verbatim into the REAL cache modules (src/vector-cortex/cache/{crystal,store}.js),
// no mocks.
//
// `input.scenario` selects which real entry point the acceptance test drives:
//   "key"     — encodeCrystalKey(key), asserting ok/code (and sortedSessions for
//               canonical-ordering rows).
//   "compare" — encodeCrystalKey on BOTH keys, asserting `expected.sameKey`:
//               true  = the mutation was NOT an identity field (frontier);
//               false = the mutation WAS an identity field and invalidated.
//   "store"   — freeze + write (+ a second write for collision/idempotence rows),
//               asserting ok/code/written and the resulting crystalCount.
//
// DIGESTS ARE COMPUTED, NEVER HAND-WRITTEN. Every `digest` below is a real
// SHA-256 over the row's own byte content, so the corpus is self-consistent by
// construction: a fixture whose "one covered byte changed" claim were false
// would produce an unchanged digest and CRY-COVERED-002 would fail.
//
// THE FRONTIER IS NOT AN INPUT. There is deliberately no global-frontier field
// in this schema. CRY-FRONTIER-001 expresses "an unrelated append" the only way
// the contract allows: an extra range appended to a DIFFERENT session's stream
// that the key does not cover — the key it produces must be byte-identical.
//
// CRY-001..015 are the registered VC7A crystal rows and PRO-016..023 the
// provider/renderer identity rows (continuing VC5B's PRO-001..015). The three
// NAMED rows (CRY-FRONTIER-001 / CRY-COVERED-002 / CRY-DEP-003) pin the sprint's
// headline assertions: an unrelated append leaves the key unchanged, one covered
// byte change invalidates it, and a dependency high-water advance invalidates it.

import { createHash } from "node:crypto";

import { producer } from "./common.mjs";

const CRYSTAL_SCHEMA = "schemas/cache-crystal-fixture.schema.json";

/** `sha256:<hex>` over the given text — the DagSpan / coveredDigest convention. */
const spanDigest = (text) =>
  `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;

/** Bare lowercase hex — the requestDigest / content-address convention. */
const bareDigest = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * One covered range. `text` is the notional covered content: its SHA-256 becomes
 * the span's pinned digest, so changing a single character here really does
 * change the covered digest (that is what CRY-COVERED-002 asserts).
 */
const span = (sessionId, startSeq, endSeq, startByte, endByte, text) => ({
  sessionId,
  startSeq,
  endSeq,
  startByte,
  endByte,
  digest: spanDigest(text),
});

/** A crystal identity. Defaults keep every row's non-varied fields constant. */
const key = (sourceRanges, extra = {}) => ({
  profileId: "anthropic-claude-opus",
  profileVersion: "v1",
  requestDigest: bareDigest("canonical-request-a"),
  rendererVersion: "render-v1",
  dependencyHighWater: 100,
  sourceRanges,
  ...extra,
});

const BASE_SPANS = [
  span("s-alpha", 1, 2, 0, 64, "alpha-turn-one"),
  span("s-alpha", 3, 4, 64, 160, "alpha-turn-two"),
];

function crystalFixture(id, assertion, input, expected) {
  return { id, schema: CRYSTAL_SCHEMA, producer, assertion, kind: "cache-crystal", input, expected };
}

const keyRow = (id, assertion, scenario, k, expected) =>
  crystalFixture(id, assertion, { scenario: "key", mode: scenario, key: k }, expected);

const compareRow = (id, assertion, scenario, a, b, sameKey) =>
  crystalFixture(
    id,
    assertion,
    { scenario: "compare", mode: scenario, key: a, other: b },
    { ok: true, sameKey },
  );

const storeRow = (id, assertion, scenario, k, bytes, second, expected) =>
  crystalFixture(
    id,
    assertion,
    { scenario: "store", mode: scenario, key: k, bytes, ...(second === null ? {} : { secondBytes: second }) },
    expected,
  );

export const fixtures = [
  // ── Canonical key encoding (CRY-001..005) ──────────────────────────────────
  keyRow("CRY-001", "a well-formed two-range key encodes to a stable digest", "encode", key(BASE_SPANS), {
    ok: true,
    rangeCount: 2,
  }),
  keyRow(
    "CRY-002",
    "ranges supplied out of order sort by (session, startSeq, startByte)",
    "encode-sorted",
    key([BASE_SPANS[1], BASE_SPANS[0]]),
    { ok: true, rangeCount: 2, sortedStartBytes: [0, 64] },
  ),
  keyRow(
    "CRY-003",
    "cross-session ranges are legal and sort by session id first",
    "encode-sorted",
    key([span("s-beta", 1, 1, 0, 32, "beta-one"), span("s-alpha", 9, 9, 512, 544, "alpha-nine")]),
    { ok: true, rangeCount: 2, sortedSessions: ["s-alpha", "s-beta"] },
  ),
  keyRow(
    "CRY-004",
    "adjacent half-open ranges (a.end === b.start) do not overlap",
    "encode",
    key([span("s-alpha", 1, 1, 0, 64, "adj-a"), span("s-alpha", 2, 2, 64, 128, "adj-b")]),
    { ok: true, rangeCount: 2 },
  ),
  keyRow(
    "CRY-005",
    "a single-range key encodes cleanly",
    "encode",
    key([span("s-alpha", 1, 1, 0, 16, "solo")]),
    { ok: true, rangeCount: 1 },
  ),

  // ── Range rejection (CRY-006..009) ─────────────────────────────────────────
  keyRow(
    "CRY-006",
    "two overlapping ranges in the same session are rejected",
    "encode",
    key([span("s-alpha", 1, 2, 0, 96, "ov-a"), span("s-alpha", 2, 3, 64, 160, "ov-b")]),
    { ok: false, code: "CRY_RANGE_OVERLAP", rangeCount: 2 },
  ),
  keyRow(
    "CRY-007",
    "a fully contained range is an overlap, not a nesting",
    "encode",
    key([span("s-alpha", 1, 4, 0, 256, "outer"), span("s-alpha", 2, 2, 32, 64, "inner")]),
    { ok: false, code: "CRY_RANGE_OVERLAP", rangeCount: 2 },
  ),
  keyRow("CRY-008", "an empty range set is rejected", "encode", key([]), {
    ok: false,
    code: "CRY_RANGE_EMPTY",
    rangeCount: 0,
  }),
  keyRow(
    "CRY-009",
    "a reversed byte range is malformed and rejected",
    "encode",
    key([span("s-alpha", 1, 1, 128, 64, "reversed")]),
    { ok: false, code: "CRY_RANGE_INVALID", rangeCount: 1 },
  ),

  // ── Invalidation (CRY-010..012) ────────────────────────────────────────────
  compareRow(
    "CRY-010",
    "a renderer version bump invalidates the key",
    "renderer",
    key(BASE_SPANS),
    key(BASE_SPANS, { rendererVersion: "render-v2" }),
    false,
  ),
  compareRow(
    "CRY-011",
    "a profile version bump invalidates the key",
    "profile",
    key(BASE_SPANS),
    key(BASE_SPANS, { profileVersion: "v2" }),
    false,
  ),
  compareRow(
    "CRY-012",
    "range order is not identity: the same ranges in any order key the same",
    "reorder",
    key([BASE_SPANS[0], BASE_SPANS[1]]),
    key([BASE_SPANS[1], BASE_SPANS[0]]),
    true,
  ),

  // ── Content-addressed write-once store (CRY-013..015) ──────────────────────
  storeRow("CRY-013", "a first write publishes exactly one crystal", "write", key(BASE_SPANS), "frozen-render-a", null, {
    ok: true,
    written: true,
    crystalCount: 1,
  }),
  storeRow(
    "CRY-014",
    "re-writing byte-identical bytes is idempotent and stores nothing new",
    "rewrite",
    key(BASE_SPANS),
    "frozen-render-a",
    "frozen-render-a",
    { ok: true, written: false, crystalCount: 1 },
  ),
  storeRow(
    "CRY-015",
    "an existing key with different bytes collides and is never overwritten",
    "rewrite",
    key(BASE_SPANS),
    "frozen-render-a",
    "frozen-render-b",
    { ok: false, code: "CRY_KEY_COLLISION", written: false, crystalCount: 1 },
  ),

  // ── Provider/renderer identity rows (PRO-016..023) ─────────────────────────
  compareRow(
    "PRO-016",
    "the same profile and renderer over the same ranges keys identically",
    "profile",
    key(BASE_SPANS),
    key(BASE_SPANS),
    true,
  ),
  compareRow(
    "PRO-017",
    "a different profile id invalidates the key",
    "profile",
    key(BASE_SPANS),
    key(BASE_SPANS, { profileId: "openai-gpt" }),
    false,
  ),
  compareRow(
    "PRO-018",
    "a different request digest invalidates the key",
    "profile",
    key(BASE_SPANS),
    key(BASE_SPANS, { requestDigest: bareDigest("canonical-request-b") }),
    false,
  ),
  compareRow(
    "PRO-019",
    "a renderer downgrade is still a change and invalidates the key",
    "renderer",
    key(BASE_SPANS, { rendererVersion: "render-v2" }),
    key(BASE_SPANS, { rendererVersion: "render-v1" }),
    false,
  ),
  compareRow(
    "PRO-020",
    "a dependency high-water regression invalidates the key",
    "dependency",
    key(BASE_SPANS),
    key(BASE_SPANS, { dependencyHighWater: 99 }),
    false,
  ),
  keyRow(
    "PRO-021",
    "a profile-framed key over cross-session ranges encodes cleanly",
    "encode",
    key([span("s-alpha", 1, 1, 0, 32, "pro-a"), span("s-gamma", 1, 1, 0, 32, "pro-g")], {
      profileId: "google-gemini",
    }),
    { ok: true, rangeCount: 2 },
  ),
  storeRow(
    "PRO-022",
    "two profiles over the same ranges are distinct crystals, not a collision",
    "write-two-profiles",
    key(BASE_SPANS),
    "frozen-render-opus",
    "frozen-render-gpt",
    { ok: true, written: true, crystalCount: 2 },
  ),
  storeRow(
    "PRO-023",
    "an unavailable store refuses the write and serves nothing (mode C)",
    "unavailable",
    key(BASE_SPANS),
    "frozen-render-a",
    null,
    { ok: false, code: "CRY_STORE_UNAVAILABLE", written: false, crystalCount: 0, mode: "C" },
  ),
];

export const named = [
  crystalFixture(
    "CRY-FRONTIER-001",
    "an unrelated append (a range the key does not cover) leaves the key unchanged (named headline)",
    {
      scenario: "compare",
      mode: "frontier",
      key: key(BASE_SPANS),
      // Identical covered ranges. The "append" happened on s-omega, a session
      // this crystal does not cover: it advances the global frontier and is
      // therefore not representable in the key at all. Byte-identical digest.
      other: key([BASE_SPANS[1], BASE_SPANS[0]], { dependencyHighWater: 100 }),
      unrelatedAppend: span("s-omega", 7, 7, 0, 48, "unrelated-append"),
    },
    { ok: true, sameKey: true },
  ),
  crystalFixture(
    "CRY-COVERED-002",
    "one covered byte change invalidates the key (named headline)",
    {
      scenario: "compare",
      mode: "covered",
      key: key(BASE_SPANS),
      // Same session, same seq/byte bounds — only the covered CONTENT differs by
      // a single character, so only the pinned span digest changes.
      other: key([
        BASE_SPANS[0],
        span("s-alpha", 3, 4, 64, 160, "alpha-turn-twa"),
      ]),
    },
    { ok: true, sameKey: false },
  ),
  crystalFixture(
    "CRY-DEP-003",
    "a dependency high-water advance invalidates the key (named headline)",
    {
      scenario: "compare",
      mode: "dependency",
      key: key(BASE_SPANS),
      other: key(BASE_SPANS, { dependencyHighWater: 101 }),
    },
    { ok: true, sameKey: false },
  ),
];
