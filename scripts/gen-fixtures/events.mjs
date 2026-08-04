// VC1A EventV2 fixtures EVT-001..015.
// Owner VC1A: EventV2 byte-authority codec (A) + canonical validator + mode-B
// raw byte record (see src/vector-cortex/ledger/types.ts). Binary fields are
// standard base64 (Buffer.from(...).toString("base64")); the acceptance test
// decodes them and runs the codec/validator over the real bytes.

import { producer, b64, b64bytes, sha256Hex } from "./common.mjs";

const EVENT_SCHEMA = "schemas/event-fixture.schema.json";

/**
 * Build an encode-kind event fixture: bytes are round-tripped through the codec.
 * kind "encode": codec.encode(bytes) — the acceptance test asserts the returned
 * bytes digest exactly match, strict UTF-8 classification is as expected, and
 * decode(encode(...)).originalBytes === input bytes.
 */
function encodeFixture(id, assertion, events, expected) {
  return { id, schema: EVENT_SCHEMA, producer, assertion, kind: "encode", input: { events }, expected };
}

/**
 * Build a validate-kind event fixture: events are assembled into stored EventV2
 * (honoring optional bytesDigest/utf8Tag corruption overrides) and passed to the
 * canonical validator.
 */
function validateFixture(id, assertion, events, expected) {
  return {
    id,
    schema: EVENT_SCHEMA,
    producer,
    assertion,
    kind: "validate",
    input: { events },
    expected,
  };
}

/** Minimal envelope for a single occurrence. */
function ev(over) {
  return Object.assign(
    {
      sessionId: "s1",
      seq: 1,
      eventId: "e1",
      role: "user",
      kind: "message",
      bytesBase64: b64bytes(new TextEncoder().encode("hi")),
      occurredAtMs: 0,
    },
    over || {},
  );
}

// EVT-001 = EVT-UTF8-001: invalid sequence `ff fe` round-trips byte-for-byte,
// classifies as {valid:false, base64}, never lossy-replaced.
const evt001 = encodeFixture(
  "EVT-001",
  "EVT-UTF8-001: invalid sequence ff fe round-trips byte-for-byte (no replacement)",
  [ev({ sessionId: "s-utf8", seq: 1, eventId: "fffe", bytesBase64: b64bytes(new Uint8Array([0xff, 0xfe])) })],
  { ok: true, utf8Valid: false },
);

// EVT-002 = EVT-NFC-002: composed and decomposed e-acute remain distinct
// identities (distinct digests) but share the derived canonicalNfc.
const eComposed = new TextEncoder().encode("é"); // C3 A9
const eDecomposed = new TextEncoder().encode("é"); // 65 CC 81
const evt002 = encodeFixture(
  "EVT-002",
  "EVT-NFC-002: composed and decomposed e-acute remain distinct identities (distinct digests, equal canonical NFC)",
  [
    ev({ sessionId: "s-nfc", seq: 1, eventId: "nfc-b", bytesBase64: b64(eComposed) }),
    ev({ sessionId: "s-nfc", seq: 2, eventId: "nfc-a", bytesBase64: b64(eDecomposed) }),
  ],
  { ok: true, utf8Valid: true, distinctDigests: true, equalNfc: true, canonicalNfc: "é" },
);

// EVT-003 = EVT-TIE-003: equal session/seq sorts unsigned eventId BYTES. The
// eventIds include a non-BMP char (U+10000) whose UTF-8 first byte (F0) sorts
// AFTER U+E000 (EE) even though its JS code unit (surrogate D800) is LOWER — so
// bytewise order differs from code-unit order. A(41) < U+E000(EE) < U+10000(F0).
const tieA = new TextEncoder().encode("A");
const tieB = new TextEncoder().encode(String.fromCodePoint(0xe000));
const tieC = new TextEncoder().encode(String.fromCodePoint(0x10000));
const evt003 = validateFixture(
  "EVT-003",
  "EVT-TIE-003: equal session/seq sorts unsigned eventId bytes (code-unit vs byte divergence)",
  [
    ev({ sessionId: "s-tie", seq: 1, eventId: String.fromCodePoint(0xe000), bytesBase64: b64(tieB) }),
    ev({ sessionId: "s-tie", seq: 1, eventId: "A", bytesBase64: b64(tieA) }),
    ev({ sessionId: "s-tie", seq: 1, eventId: String.fromCodePoint(0x10000), bytesBase64: b64(tieC) }),
  ],
  { ok: true, order: ["A", String.fromCodePoint(0xe000), String.fromCodePoint(0x10000)] },
);

// EVT-004: plain ASCII round-trips as valid UTF-8.
const evt004 = encodeFixture(
  "EVT-004",
  "valid ASCII round-trips byte-for-byte with text + canonical NFC",
  [ev({ sessionId: "s-ascii", seq: 1, eventId: "hl", bytesBase64: b64bytes(new TextEncoder().encode("hello world")) })],
  { ok: true, utf8Valid: true, canonicalNfc: "hello world" },
);

// EVT-005: multi-byte UTF-8 with a composable base — NFC is derived, never identity.
const evt005 = encodeFixture(
  "EVT-005",
  "multi-byte UTF-8 (café composed) decodes and derives canonical NFC",
  [ev({ sessionId: "s-mb", seq: 1, eventId: "cafe", bytesBase64: b64bytes(new TextEncoder().encode("café")) })],
  { ok: true, utf8Valid: true, canonicalNfc: "café" },
);

// EVT-006: overlong invalid sequence C0 AF round-trips as invalid base64.
const evt006 = encodeFixture(
  "EVT-006",
  "overlong sequence c0 af classifies invalid and round-trips byte-for-byte",
  [ev({ sessionId: "s-inv2", seq: 1, eventId: "c0af", bytesBase64: b64bytes(new Uint8Array([0xc0, 0xaf])) })],
  { ok: true, utf8Valid: false },
);

// EVT-007: empty bytes are valid UTF-8 with empty text.
const evt007 = encodeFixture(
  "EVT-007",
  "empty byte array is valid UTF-8 with empty text and NFC",
  [ev({ sessionId: "s-empty", seq: 1, eventId: "empty", bytesBase64: b64bytes(new Uint8Array(0)) })],
  { ok: true, utf8Valid: true, canonicalNfc: "" },
);

// EVT-008: a UTF-8 BOM (EF BB BF) is valid; the strict decoder strips the leading
// BOM (encoding marker, not content) from the derived text/NFC — never from the
// authoritative originalBytes, which still round-trip byte-for-byte.
const evt008 = encodeFixture(
  "EVT-008",
  "UTF-8 BOM bytes decode strictly (BOM stripped from derived NFC, bytes round-trip)",
  [ev({ sessionId: "s-bom", seq: 1, eventId: "bom", bytesBase64: b64bytes(new TextEncoder().encode("﻿hello")) })],
  { ok: true, utf8Valid: true, canonicalNfc: "hello" },
);

// EVT-009: validate — stored digest does not match recomputed sha256(originalBytes).
// This is the unique failure injection: a stored byte SHA-256 retained against
// changed originalBytes -> EVT_DIGEST_MISMATCH (no replacement text anywhere).
const evt009 = validateFixture(
  "EVT-009",
  "stored digest mismatch -> EVT_DIGEST_MISMATCH (no replacement text)",
  [
    ev({
      sessionId: "s-dm",
      seq: 1,
      eventId: "d1",
      bytesBase64: b64bytes(new TextEncoder().encode("payload bytes")),
      bytesDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
  ],
  { ok: false, codes: ["EVT_DIGEST_MISMATCH"] },
);

// EVT-010: validate — stored utf8 discriminant contradicts the actual (valid) bytes.
const evt010 = validateFixture(
  "EVT-010",
  "stored utf8 tag invalid but bytes are valid UTF-8 -> EVT_UTF8_TAG_INVALID",
  [
    ev({
      sessionId: "s-utf8t",
      seq: 1,
      eventId: "t1",
      bytesBase64: b64bytes(new TextEncoder().encode("plain ascii")),
      utf8Tag: "invalid",
    }),
  ],
  { ok: false, codes: ["EVT_UTF8_TAG_INVALID"] },
);

// EVT-011: validate — duplicate (sessionId, seq, eventId) occurrence.
const evt011 = validateFixture(
  "EVT-011",
  "duplicate (sessionId, seq, eventId) -> EVT_DUPLICATE_ID",
  [
    ev({ sessionId: "s-dup", seq: 1, eventId: "dup", bytesBase64: b64bytes(new TextEncoder().encode("first")) }),
    ev({ sessionId: "s-dup", seq: 1, eventId: "dup", bytesBase64: b64bytes(new TextEncoder().encode("first")) }),
  ],
  { ok: false, codes: ["EVT_DUPLICATE_ID"] },
);

// EVT-012: validate — mixed failures surface in deterministic priority order
// (digest first, then duplicate).
const evt012 = validateFixture(
  "EVT-012",
  "digest mismatch + duplicate surfacing in deterministic priority order",
  [
    ev({
      sessionId: "s-mix",
      seq: 1,
      eventId: "m1",
      bytesBase64: b64bytes(new TextEncoder().encode("ok")),
      bytesDigest: "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    }),
    ev({ sessionId: "s-mix", seq: 2, eventId: "m2", bytesBase64: b64bytes(new TextEncoder().encode("dup")) }),
    ev({
      sessionId: "s-mix",
      seq: 2,
      eventId: "m2",
      bytesBase64: b64bytes(new TextEncoder().encode("dup")),
    }),
  ],
  { ok: false, codes: ["EVT_DIGEST_MISMATCH", "EVT_DUPLICATE_ID"] },
);

// EVT-013: validate — canonical (session, seq) ordering across sessions is ok.
const evt013 = validateFixture(
  "EVT-013",
  "canonical (session, seq) ordering across sessions",
  [
    ev({ sessionId: "s2", seq: 1, eventId: "s2-1", bytesBase64: b64bytes(new TextEncoder().encode("s2 first")) }),
    ev({ sessionId: "s1", seq: 2, eventId: "s1-2", bytesBase64: b64bytes(new TextEncoder().encode("s1 second")) }),
    ev({ sessionId: "s1", seq: 1, eventId: "s1-1", bytesBase64: b64bytes(new TextEncoder().encode("s1 first")) }),
  ],
  { ok: true, order: ["s1-1", "s1-2", "s2-1"] },
);

// EVT-014: validate — a stored byte is flipped to an INVALID UTF-8 sequence
// (ff 00) while the ORIGINAL VALID message's SHA-256 is retained -> the stored
// digest no longer matches the stored bytes (EVT_DIGEST_MISMATCH) AND the bytes
// are no longer valid while the tag still claims valid (EVT_UTF8_TAG_INVALID).
const evt014Origin = new TextEncoder().encode("aa"); // valid message whose digest is retained
const evt014 = validateFixture(
  "EVT-014",
  "flip one byte to invalid UTF-8 while retaining the original digest -> digest mismatch + utf8 tag invalid",
  [
    ev({
      sessionId: "s-flip",
      seq: 1,
      eventId: "f1",
      // stored bytes are the FLIPPED (invalid) variant of a valid message.
      bytesBase64: b64bytes(new Uint8Array([0xff, 0x00])),
      // retained digest of the ORIGINAL valid "aa" message.
      bytesDigest: "sha256:" + sha256Hex(evt014Origin),
      utf8Tag: "valid",
    }),
  ],
  { ok: false, codes: ["EVT_DIGEST_MISMATCH", "EVT_UTF8_TAG_INVALID"] },
);

// EVT-015: validate — a tool RESULT references exactly one earlier CALL in the
// same session; valid ordering with a toolCallId round-trips ok.
const evt015 = validateFixture(
  "EVT-015",
  "tool call/result pair in a session is valid and ordered by (seq, eventId)",
  [
    ev({ sessionId: "s-tool", seq: 1, eventId: "call", role: "assistant", kind: "tool_call", toolCallId: "tc1", bytesBase64: b64bytes(new TextEncoder().encode("call")) }),
    ev({ sessionId: "s-tool", seq: 2, eventId: "res", role: "tool", kind: "tool_result", toolCallId: "tc1", bytesBase64: b64bytes(new TextEncoder().encode("result")) }),
    ev({ sessionId: "s-tool", seq: 3, eventId: "tail", bytesBase64: b64bytes(new TextEncoder().encode("tail")) }),
  ],
  { ok: true, order: ["call", "res", "tail"] },
);

export const fixtures = [
  evt001, evt002, evt003, evt004, evt005, evt006, evt007, evt008,
  evt009, evt010, evt011, evt012, evt013, evt014, evt015,
];
