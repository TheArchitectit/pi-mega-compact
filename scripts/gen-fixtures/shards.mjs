// VC4A dual-tier shard fixtures
// (`conformance/vector-cortex/v2/shards/`).
//
// Owner VC4A (SemanticShardV1 / ExactShardV1 / ShardManifestV1). Each fixture
// declares a semantic-partition / exact-partition / manifest-coverage condition
// the acceptance test executes against the REAL shard logic
// (src/vector-cortex/shards/{semantic,exact,manifest}.js), no mocks.
// `input.scenario` names the condition; `expected.ok` pins the successful
// behavior or the exact failure `code`.
//
// SHD-001..020 are the registered VC4A conformance rows; the three NAMED rows
// (SHD-PAIR-001 / SHD-UTF8-002 / SHD-RANGE-003) pin the sprint's headline
// assertions (call/result spanning the target size stays in ONE exact shard /
// invalid UTF-8 bytes are exact-only and unchanged / overlapping semantic/exact
// coverage is rejected).

import { producer } from "./common.mjs";

const SHARD_SCHEMA = "schemas/shard-fixture.schema.json";

function shardFixture(id, assertion, input, expected) {
  return { id, schema: SHARD_SCHEMA, producer, assertion, kind: "shard", input, expected };
}

// Standard base64 (Buffer.from(...).toString("base64")) so fixtures carry
// arbitrary bytes; the acceptance test decodes these to build EventV2.
const b64 = (s) => Buffer.from(s).toString("base64");

// A short helper to build one event descriptor.
const ev = (e) => ({
  seq: e.seq,
  eventId: e.eventId,
  role: e.role,
  kind: e.kind,
  ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
  bytesBase64: b64(e.text),
});

export const fixtures = [
  // ── Semantic tier (SHD-001..010) ──────────────────────────────────────────
  shardFixture(
    "SHD-001",
    "a stream that fills exactly one target-size budget yields a single semantic shard",
    {
      scenario: "boundary-exact",
      sessionId: "s1",
      targetSize: 12,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
        ev({ seq: 3, eventId: "c", role: "user", kind: "message", text: "cccc" }),
      ],
    },
    { ok: true, shardCount: 1, eventCount: 3 },
  ),
  shardFixture(
    "SHD-002",
    "a stream over one target budget splits ONLY at complete record boundaries",
    {
      scenario: "split-at-boundary",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
        ev({ seq: 3, eventId: "c", role: "user", kind: "message", text: "cccc" }),
        ev({ seq: 4, eventId: "d", role: "assistant", kind: "message", text: "dddd" }),
      ],
    },
    { ok: true, shardCount: 2, eventCount: 4 },
  ),
  shardFixture(
    "SHD-003",
    "a single over-budget record still occupies its own complete semantic shard",
    {
      scenario: "single-over-budget",
      sessionId: "s1",
      targetSize: 4,
      events: [ev({ seq: 1, eventId: "big", role: "user", kind: "message", text: "abcdefgh" })],
    },
    { ok: true, shardCount: 1, eventCount: 1 },
  ),
  shardFixture(
    "SHD-004",
    "an empty stream yields zero semantic shards",
    { scenario: "empty-stream", sessionId: "s1", targetSize: 16, events: [] },
    { ok: true, shardCount: 0, eventCount: 0 },
  ),
  shardFixture(
    "SHD-005",
    "semantic shard ranges preserve the exact source seq and byte window",
    {
      scenario: "range-metadata",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
      ],
    },
    { ok: true, shardCount: 1, eventCount: 2 },
  ),
  shardFixture(
    "SHD-006",
    "mixed-session events reject the semantic partition (SHD_CROSS_SESSION)",
    {
      scenario: "cross-session",
      sessionId: "s1",
      targetSize: 16,
      events: [ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" })],
    },
    { ok: false, code: "SHD_CROSS_SESSION" },
  ),
  shardFixture(
    "SHD-007",
    "a non-positive target size rejects the semantic partition (SHD_INVALID_TARGET_SIZE)",
    {
      scenario: "invalid-target",
      sessionId: "s1",
      targetSize: 0,
      events: [ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "a" })],
    },
    { ok: false, code: "SHD_INVALID_TARGET_SIZE" },
  ),
  shardFixture(
    "SHD-008",
    "semantic shard byte ranges tile the full stream disjointly and contiguously",
    {
      scenario: "contiguous-coverage",
      sessionId: "s1",
      targetSize: 3,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbb" }),
        ev({ seq: 3, eventId: "c", role: "user", kind: "message", text: "ccc" }),
        ev({ seq: 4, eventId: "d", role: "assistant", kind: "message", text: "ddd" }),
      ],
    },
    { ok: true, shardCount: 4, eventCount: 4 },
  ),
  shardFixture(
    "SHD-009",
    "semantic eventCount and byteCount match the covered records exactly",
    {
      scenario: "count-and-bytes",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
      ],
    },
    { ok: true, shardCount: 1, eventCount: 2 },
  ),
  shardFixture(
    "SHD-010",
    "the semantic partition is deterministic (identical input yields identical digests)",
    {
      scenario: "deterministic-digest",
      sessionId: "s1",
      targetSize: 4,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
      ],
    },
    { ok: true, shardCount: 2, eventCount: 2 },
  ),

  // ── Exact tier (SHD-011..015) ─────────────────────────────────────────────
  shardFixture(
    "SHD-011",
    "a tool call/result pair spanning the target size stays in ONE exact shard (SHD-PAIR)",
    {
      scenario: "pair-atomic",
      sessionId: "s1",
      targetSize: 5,
      events: [
        ev({ seq: 1, eventId: "c9", role: "assistant", kind: "tool_call", toolCallId: "tc1", text: "call-" }),
        ev({ seq: 2, eventId: "r1", role: "tool", kind: "tool_result", toolCallId: "tc1", text: "-result" }),
      ],
      protected: [{ case: "tool-pair", seqs: [1, 2] }],
    },
    { ok: true, shardCount: 1, eventCount: 2 },
  ),
  shardFixture(
    "SHD-012",
    "invalid UTF-8 bytes are preserved verbatim in the exact shard (never recoded)",
    {
      scenario: "invalid-preserved",
      sessionId: "s1",
      targetSize: 16,
      events: [
        { seq: 1, eventId: "bad", role: "user", kind: "message", bytesBase64: b64(Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0x00, 0xfe])) },
      ],
      protected: [{ case: "invalid-utf8", seqs: [1] }],
    },
    { ok: true, shardCount: 1, eventCount: 1 },
  ),
  shardFixture(
    "SHD-013",
    "multiple protected spans bundle into target-size-bounded exact shards",
    {
      scenario: "group-by-budget",
      sessionId: "s1",
      targetSize: 6,
      events: [
        ev({ seq: 1, eventId: "a", role: "assistant", kind: "tool_call", toolCallId: "t1", text: "aaaaaa" }),
        ev({ seq: 2, eventId: "b", role: "tool", kind: "tool_result", toolCallId: "t1", text: "bbbbbb" }),
        ev({ seq: 3, eventId: "c", role: "assistant", kind: "tool_call", toolCallId: "t2", text: "cccccc" }),
        ev({ seq: 4, eventId: "d", role: "tool", kind: "tool_result", toolCallId: "t2", text: "dddddd" }),
      ],
      protected: [
        { case: "tool-pair", seqs: [1, 2] },
        { case: "tool-pair", seqs: [3, 4] },
      ],
    },
    { ok: true, shardCount: 2, eventCount: 4 },
  ),
  shardFixture(
    "SHD-014",
    "no protected spans yields zero exact shards",
    {
      scenario: "empty-protected",
      sessionId: "s1",
      targetSize: 16,
      events: [ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" })],
      protected: [],
    },
    { ok: true, shardCount: 0, eventCount: 0 },
  ),
  shardFixture(
    "SHD-015",
    "a protected span referencing an absent event rejects the exact partition",
    {
      scenario: "cross-session-exact",
      sessionId: "s1",
      targetSize: 16,
      events: [ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" })],
      protected: [{ case: "anchor", seqs: [99] }],
    },
    { ok: false, code: "SHD_CROSS_SESSION" },
  ),

  // ── Manifest tier (SHD-016..020) ──────────────────────────────────────────
  shardFixture(
    "SHD-016",
    "a manifest with disjoint shards and full protected-span coverage validates",
    {
      scenario: "valid-cover",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "c9", role: "assistant", kind: "tool_call", toolCallId: "t1", text: "bbbb" }),
        ev({ seq: 3, eventId: "r1", role: "tool", kind: "tool_result", toolCallId: "t1", text: "cccc" }),
      ],
      protected: [{ case: "tool-pair", seqs: [2, 3] }],
    },
    { ok: true, shardCount: 2, eventCount: 3 },
  ),
  shardFixture(
    "SHD-017",
    "overlapping semantic shard ranges are rejected (SHD_RANGE_OVERLAP)",
    {
      scenario: "overlap-reject",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
      ],
      protected: [],
    },
    { ok: false, code: "SHD_RANGE_OVERLAP" },
  ),
  shardFixture(
    "SHD-018",
    "a missing exact shard leaves a protected-span gap (SHD_PROTECTED_GAP)",
    {
      scenario: "gap-reject",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "c9", role: "assistant", kind: "tool_call", toolCallId: "t1", text: "bbbb" }),
        ev({ seq: 2, eventId: "r1", role: "tool", kind: "tool_result", toolCallId: "t1", text: "cccc" }),
      ],
      protected: [{ case: "tool-pair", seqs: [1, 2] }],
    },
    { ok: false, code: "SHD_PROTECTED_GAP" },
  ),
  shardFixture(
    "SHD-019",
    "assembled manifest ranges are sorted by (seqStart, byteStart)",
    {
      scenario: "sorted-ranges",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "c9", role: "assistant", kind: "tool_call", toolCallId: "t1", text: "bbbb" }),
        ev({ seq: 3, eventId: "r1", role: "tool", kind: "tool_result", toolCallId: "t1", text: "cccc" }),
      ],
      protected: [{ case: "tool-pair", seqs: [2, 3] }],
    },
    { ok: true, shardCount: 2, eventCount: 3 },
  ),
  shardFixture(
    "SHD-020",
    "the manifest generation digest is deterministic across build orders",
    {
      scenario: "digest-stable",
      sessionId: "s1",
      targetSize: 4,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
        ev({ seq: 3, eventId: "c", role: "user", kind: "message", text: "cccc" }),
      ],
      protected: [],
    },
    { ok: true, shardCount: 3, eventCount: 3 },
  ),
];

export const named = [
  shardFixture(
    "SHD-PAIR-001",
    "a call/result spanning the target size stays in ONE exact shard (named)",
    {
      scenario: "pair-atomic",
      sessionId: "s1",
      targetSize: 5,
      events: [
        ev({ seq: 1, eventId: "c9", role: "assistant", kind: "tool_call", toolCallId: "tc1", text: "call-" }),
        ev({ seq: 2, eventId: "r1", role: "tool", kind: "tool_result", toolCallId: "tc1", text: "-result" }),
      ],
      protected: [{ case: "tool-pair", seqs: [1, 2] }],
    },
    { ok: true, shardCount: 1, eventCount: 2 },
  ),
  shardFixture(
    "SHD-UTF8-002",
    "invalid UTF-8 bytes are exact-only and preserved unchanged (named)",
    {
      scenario: "invalid-preserved",
      sessionId: "s1",
      targetSize: 16,
      events: [
        { seq: 1, eventId: "bad", role: "user", kind: "message", bytesBase64: b64(Buffer.from([0xff, 0xfe, 0x00, 0xc0, 0xaf])) },
      ],
      protected: [{ case: "invalid-utf8", seqs: [1] }],
    },
    { ok: true, shardCount: 1, eventCount: 1 },
  ),
  shardFixture(
    "SHD-RANGE-003",
    "overlapping semantic/exact coverage is rejected (named)",
    {
      scenario: "overlap-reject",
      sessionId: "s1",
      targetSize: 8,
      events: [
        ev({ seq: 1, eventId: "a", role: "user", kind: "message", text: "aaaa" }),
        ev({ seq: 2, eventId: "b", role: "assistant", kind: "message", text: "bbbb" }),
      ],
      protected: [{ case: "anchor", seqs: [1] }],
    },
    { ok: false, code: "SHD_RANGE_OVERLAP" },
  ),
];
