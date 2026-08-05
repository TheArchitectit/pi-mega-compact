// VC6B exact source restoration fixtures
// (`conformance/vector-cortex/v2/restoration/`).
//
// Owner VC6B (restoreSources / verifyRestored / RestoreRequestV1 /
// RestoreResultV1). Each fixture carries a FULL restore request plus the exact
// sources available to it (`input.exactShards` / `input.ledgerEvents`), which
// the acceptance test decodes into real ExactShardV1 / EventV2 objects and feeds
// verbatim into the REAL heal modules (src/vector-cortex/heal/{restore,verify}.js),
// no mocks. `expected` pins the restore verdict:
//
//   ok            — the restoration completed AND verifyRestored returned ok.
//   code          — the HEAL_RESTORE_* code the restorer returned (failures).
//   restoredCount — spans restored from an exact source.
//   missingCount  — spans no exact source covered.
//   mode          — A (indexed exact shards) / B (ledger range scan) / C (loss).
//
// ENCODING. Fixtures are JSON, so:
//   - bytes are base64 (`bytesBase64` / `originalBytesBase64`) so arbitrary /
//     invalid-UTF-8 payloads survive the round trip unchanged;
//   - `seq` is a NUMBER here and is converted to BigInt by the acceptance
//     loader (JSON has no bigint).
//
// DIGESTS ARE COMPUTED, NEVER HAND-WRITTEN. Every `digest` / `bytesDigest` below
// is a real SHA-256 over the actual decoded bytes, produced here by node:crypto,
// so the corpus is self-consistent by construction. Span digests are BARE
// lowercase hex (the ExactShardV1.digest / RestoreSpanRequest convention);
// EventV2.bytesDigest carries the `sha256:` prefix. HEAL-DIGEST-003 is the one
// deliberate exception — it pins a digest that does NOT match its bytes, which is
// the whole point of that row.
//
// HEAL-016..030 are the registered VC6B conformance rows; the three NAMED rows
// (HEAL-SPAN-001 / HEAL-LIMIT-002 / HEAL-DIGEST-003) pin the sprint's headline
// assertions (an exact shard restores original bytes / an over-limit request is
// rejected before any reader call / ledger bytes with a wrong digest are never
// inserted).

import { createHash } from "node:crypto";

import { producer } from "./common.mjs";

const RESTORE_SCHEMA = "schemas/restoration-fixture.schema.json";

// Standard base64, matching shards.mjs — the acceptance test decodes these to
// build ExactShardV1 / EventV2 with byte-identical payloads.
const b64 = (s) => Buffer.from(s).toString("base64");
const hexOf = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");

/** A span range. `seq` bounds are inclusive; byte bounds are half-open. */
const range = (sessionId, seqStart, seqEnd, byteStart, byteEnd) => ({
  sessionId,
  seqStart,
  seqEnd,
  byteStart,
  byteEnd,
});

/** One requested span, digest computed over the text it should restore to. */
const span = (nodeId, r, text, digestOverride) => ({
  nodeId,
  range: r,
  digest: digestOverride ?? hexOf(text),
});

/** An exact shard carrying `text` verbatim. */
const shard = (sessionId, r, text, kase = "anchor") => ({
  sessionId,
  range: r,
  originalBytesBase64: b64(text),
  digest: hexOf(text),
  byteCount: Buffer.from(text).length,
  case: kase,
});

/** One ledger occurrence record. `bytesDigest` carries the `sha256:` prefix. */
const ev = (sessionId, seq, eventId, role, kind, text, extra = {}) => ({
  sessionId,
  seq,
  eventId,
  role,
  kind,
  originalBytesBase64: b64(text),
  bytesDigest: `sha256:${hexOf(text)}`,
  occurredAtMs: 1000 + seq,
  ...extra,
});

function restoreFixture(id, assertion, input, expected) {
  return {
    id,
    schema: RESTORE_SCHEMA,
    producer,
    assertion,
    kind: "restoration",
    input,
    expected,
  };
}

// Invalid UTF-8: a lone continuation byte + an unpaired surrogate-ish sequence.
// Represented as a latin1 string so Buffer.from() reproduces the exact bytes and
// the restorer must return them unnormalized (SHD-UTF8-002's sibling rule).
const INVALID_UTF8 = Buffer.from([0x41, 0x80, 0xfe, 0xff, 0x42]).toString("latin1");

export const fixtures = [
  // ── Exact-shard restoration, mode A (HEAL-016..020) ───────────────────────
  restoreFixture(
    "HEAL-016",
    "a single indexed exact shard restores the span's original bytes (mode A)",
    {
      scenario: "exact-single",
      sessionId: "s-restore-016",
      request: {
        spans: [span("n1", range("s-restore-016", 1, 1, 0, 5), "hello")],
      },
      exactShards: [shard("s-restore-016", range("s-restore-016", 1, 1, 0, 5), "hello")],
      ledgerEvents: [],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "A" },
  ),
  restoreFixture(
    "HEAL-017",
    "multiple disjoint spans each restore from their own exact shard (mode A)",
    {
      scenario: "exact-multi",
      sessionId: "s-restore-017",
      request: {
        spans: [
          span("n1", range("s-restore-017", 1, 1, 0, 5), "alpha"),
          span("n2", range("s-restore-017", 2, 2, 5, 9), "beta"),
          span("n3", range("s-restore-017", 3, 3, 9, 14), "gamma"),
        ],
      },
      exactShards: [
        shard("s-restore-017", range("s-restore-017", 1, 1, 0, 5), "alpha"),
        shard("s-restore-017", range("s-restore-017", 2, 2, 5, 9), "beta"),
        shard("s-restore-017", range("s-restore-017", 3, 3, 9, 14), "gamma"),
      ],
      ledgerEvents: [],
    },
    { ok: true, restoredCount: 3, missingCount: 0, mode: "A" },
  ),
  restoreFixture(
    "HEAL-018",
    "invalid UTF-8 bytes are restored verbatim from an exact shard (never normalized)",
    {
      scenario: "exact-invalid-utf8",
      sessionId: "s-restore-018",
      request: {
        spans: [span("n1", range("s-restore-018", 1, 1, 0, 5), INVALID_UTF8)],
      },
      exactShards: [
        shard("s-restore-018", range("s-restore-018", 1, 1, 0, 5), INVALID_UTF8, "invalid-utf8"),
      ],
      ledgerEvents: [],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "A" },
  ),
  restoreFixture(
    "HEAL-019",
    "a tool call/result pair span restores as ONE exact shard (pair never split)",
    {
      scenario: "exact-tool-pair",
      sessionId: "s-restore-019",
      request: {
        spans: [span("pair", range("s-restore-019", 7, 8, 0, 24), "CALL(read)|RESULT(ok)")],
      },
      exactShards: [
        shard(
          "s-restore-019",
          range("s-restore-019", 7, 8, 0, 24),
          "CALL(read)|RESULT(ok)",
          "tool-pair",
        ),
      ],
      ledgerEvents: [],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "A" },
  ),
  restoreFixture(
    "HEAL-020",
    "a large-but-in-bounds span restores from an exact shard (limits not tripped)",
    {
      scenario: "exact-large-in-bounds",
      sessionId: "s-restore-020",
      request: {
        // 1 MiB requested — well under the 4 MiB aggregate bound.
        spans: [span("big", range("s-restore-020", 1, 1, 0, 1048576), "L".repeat(4096))],
      },
      exactShards: [
        shard("s-restore-020", range("s-restore-020", 1, 1, 0, 1048576), "L".repeat(4096)),
      ],
      ledgerEvents: [],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "A" },
  ),

  // ── Ledger-scan restoration, mode B (HEAL-021..025) ───────────────────────
  restoreFixture(
    "HEAL-021",
    "with NO exact shard, a single-event span restores by ledger scan (mode B)",
    {
      scenario: "ledger-single",
      sessionId: "s-restore-021",
      request: {
        spans: [span("n1", range("s-restore-021", 1, 1, 0, 5), "hello")],
      },
      exactShards: [],
      ledgerEvents: [ev("s-restore-021", 1, "e1", "user", "message", "hello")],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "B" },
  ),
  restoreFixture(
    "HEAL-022",
    "a multi-event span concatenates the covered records in seq order (mode B)",
    {
      scenario: "ledger-concat",
      sessionId: "s-restore-022",
      request: {
        spans: [span("n1", range("s-restore-022", 1, 3, 0, 9), "aaabbbccc")],
      },
      exactShards: [],
      ledgerEvents: [
        ev("s-restore-022", 1, "e1", "user", "message", "aaa"),
        ev("s-restore-022", 2, "e2", "assistant", "message", "bbb"),
        ev("s-restore-022", 3, "e3", "user", "message", "ccc"),
      ],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "B" },
  ),
  restoreFixture(
    "HEAL-023",
    "out-of-order ledger input is sorted by seq before concatenation (mode B)",
    {
      scenario: "ledger-unordered",
      sessionId: "s-restore-023",
      request: {
        spans: [span("n1", range("s-restore-023", 1, 3, 0, 9), "aaabbbccc")],
      },
      exactShards: [],
      // Deliberately shuffled: a scan that trusted arrival order would produce
      // "cccaaabbb" and fail the span digest.
      ledgerEvents: [
        ev("s-restore-023", 3, "e3", "user", "message", "ccc"),
        ev("s-restore-023", 1, "e1", "user", "message", "aaa"),
        ev("s-restore-023", 2, "e2", "assistant", "message", "bbb"),
      ],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "B" },
  ),
  restoreFixture(
    "HEAL-024",
    "a tool call/result pair spanning two ledger events restores as one span (mode B)",
    {
      scenario: "ledger-tool-pair",
      sessionId: "s-restore-024",
      request: {
        spans: [span("pair", range("s-restore-024", 4, 5, 0, 21), "CALL(read)RESULT(ok)")],
      },
      exactShards: [],
      ledgerEvents: [
        ev("s-restore-024", 4, "c1", "tool", "tool-call", "CALL(read)"),
        ev("s-restore-024", 5, "r1", "tool", "tool-result", "RESULT(ok)", { toolCallId: "c1" }),
      ],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "B" },
  ),
  restoreFixture(
    "HEAL-025",
    "non-UTF8 ledger bytes are concatenated and restored unchanged (mode B)",
    {
      scenario: "ledger-invalid-utf8",
      sessionId: "s-restore-025",
      request: {
        spans: [
          span("n1", range("s-restore-025", 1, 2, 0, 10), `${INVALID_UTF8}${INVALID_UTF8}`),
        ],
      },
      exactShards: [],
      ledgerEvents: [
        ev("s-restore-025", 1, "e1", "user", "message", INVALID_UTF8),
        ev("s-restore-025", 2, "e2", "user", "message", INVALID_UTF8),
      ],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "B" },
  ),

  // ── Mixed sources + missing spans (HEAL-026..028) ─────────────────────────
  restoreFixture(
    "HEAL-026",
    "a mix of exact-shard and ledger-scan spans restores fully as mode B",
    {
      scenario: "mixed-exact-and-ledger",
      sessionId: "s-restore-026",
      request: {
        spans: [
          span("n1", range("s-restore-026", 1, 1, 0, 5), "alpha"),
          span("n2", range("s-restore-026", 2, 3, 5, 11), "betgam"),
        ],
      },
      // n1 is indexed; n2 must fall through to the ledger.
      exactShards: [shard("s-restore-026", range("s-restore-026", 1, 1, 0, 5), "alpha")],
      ledgerEvents: [
        ev("s-restore-026", 2, "e2", "user", "message", "bet"),
        ev("s-restore-026", 3, "e3", "assistant", "message", "gam"),
      ],
    },
    { ok: true, restoredCount: 2, missingCount: 0, mode: "B" },
  ),
  restoreFixture(
    "HEAL-027",
    "a span covered by NEITHER source is omitted and the loss is disclosed (mode C)",
    {
      scenario: "missing-span",
      sessionId: "s-restore-027",
      request: {
        spans: [
          span("n1", range("s-restore-027", 1, 1, 0, 5), "alpha"),
          span("gone", range("s-restore-027", 9, 9, 40, 45), "ghost"),
        ],
      },
      exactShards: [shard("s-restore-027", range("s-restore-027", 1, 1, 0, 5), "alpha")],
      ledgerEvents: [],
    },
    {
      ok: false,
      code: "HEAL_RESTORE_SOURCE_MISSING",
      restoredCount: 1,
      missingCount: 1,
      mode: "C",
    },
  ),
  restoreFixture(
    "HEAL-028",
    "every requested span missing yields mode C with zero restorations",
    {
      scenario: "all-missing",
      sessionId: "s-restore-028",
      request: {
        spans: [
          span("a", range("s-restore-028", 1, 1, 0, 3), "aaa"),
          span("b", range("s-restore-028", 2, 2, 3, 6), "bbb"),
        ],
      },
      exactShards: [],
      ledgerEvents: [],
    },
    {
      ok: false,
      code: "HEAL_RESTORE_SOURCE_MISSING",
      restoredCount: 0,
      missingCount: 2,
      mode: "C",
    },
  ),

  // ── Bounds (HEAL-029..030) ────────────────────────────────────────────────
  restoreFixture(
    "HEAL-029",
    "a 65-span request exceeds RESTORE_LIMIT_SPANS and is rejected (mode C)",
    {
      scenario: "limit-span-count",
      sessionId: "s-restore-029",
      request: {
        spans: Array.from({ length: 65 }, (_v, i) =>
          span(`n${i}`, range("s-restore-029", i + 1, i + 1, i, i + 1), "x"),
        ),
      },
      exactShards: [],
      ledgerEvents: [],
    },
    { ok: false, code: "HEAL_RESTORE_LIMIT", restoredCount: 0, missingCount: 65, mode: "C" },
  ),
  restoreFixture(
    "HEAL-030",
    "an aggregate byte request over 4 MiB is rejected before any read (mode C)",
    {
      scenario: "limit-aggregate-bytes",
      sessionId: "s-restore-030",
      request: {
        // 3 x 2 MiB = 6 MiB > RESTORE_LIMIT_BYTES. No real payload is needed:
        // the bound is computed from the REQUEST's ranges, before any read.
        spans: [
          span("n1", range("s-restore-030", 1, 1, 0, 2097152), "x"),
          span("n2", range("s-restore-030", 2, 2, 2097152, 4194304), "y"),
          span("n3", range("s-restore-030", 3, 3, 4194304, 6291456), "z"),
        ],
      },
      exactShards: [],
      ledgerEvents: [],
    },
    { ok: false, code: "HEAL_RESTORE_LIMIT", restoredCount: 0, missingCount: 3, mode: "C" },
  ),
];

export const named = [
  restoreFixture(
    "HEAL-SPAN-001",
    "exact shard span/digest restores the original bytes (named headline)",
    {
      scenario: "named-exact-span",
      sessionId: "s-restore-named-span",
      request: {
        spans: [
          span("n1", range("s-restore-named-span", 1, 2, 0, 11), "exact-bytes"),
        ],
      },
      exactShards: [
        shard(
          "s-restore-named-span",
          range("s-restore-named-span", 1, 2, 0, 11),
          "exact-bytes",
          "tool-pair",
        ),
      ],
      ledgerEvents: [],
    },
    { ok: true, restoredCount: 1, missingCount: 0, mode: "A" },
  ),
  restoreFixture(
    "HEAL-LIMIT-002",
    "a 65-span request is rejected BEFORE any reader call (named headline)",
    {
      scenario: "named-limit-before-read",
      sessionId: "s-restore-named-limit",
      request: {
        spans: Array.from({ length: 65 }, (_v, i) =>
          span(`n${i}`, range("s-restore-named-limit", i + 1, i + 1, i, i + 1), "x"),
        ),
      },
      // EMPTY readers by design: if the implementation consulted a reader before
      // bounding, it would report SOURCE_MISSING instead of LIMIT. The empty
      // arrays are the proof that no reader was touched.
      exactShards: [],
      ledgerEvents: [],
    },
    { ok: false, code: "HEAL_RESTORE_LIMIT", restoredCount: 0, missingCount: 65, mode: "C" },
  ),
  restoreFixture(
    "HEAL-DIGEST-003",
    "ledger bytes whose hash differs from the pinned digest are NOT inserted (named headline)",
    {
      scenario: "named-digest-rejected",
      sessionId: "s-restore-named-digest",
      request: {
        // The pinned digest is over "expected-bytes", but the ledger holds
        // "tampered-bytes". Nothing may be inserted.
        spans: [
          span(
            "n1",
            range("s-restore-named-digest", 1, 1, 0, 14),
            "expected-bytes",
            hexOf("expected-bytes"),
          ),
        ],
      },
      exactShards: [],
      ledgerEvents: [
        ev("s-restore-named-digest", 1, "e1", "user", "message", "tampered-bytes"),
      ],
    },
    {
      ok: false,
      code: "HEAL_RESTORE_DIGEST_MISMATCH",
      restoredCount: 0,
      missingCount: 1,
      mode: "C",
    },
  ),
];
