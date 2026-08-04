/**
 * vector-cortex/ledger/event-codec.test.ts — EventV2 byte-authority codec tests
 * (VC1A, mode A).
 *
 * Real logic + real bytes, no mocks. Covers: byte round-trip 100%, strict UTF-8
 * classification WITHOUT lossy replacement, canonicalNfc derived only for valid
 * UTF-8 and never used for reconstruction, digest over originalBytes, and mode-A
 * vs mode-B (independent raw byte record) byte identity.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createEventCodec, classifyUtf8 } from "./event-codec.js";
import { recordRawBytesB } from "./event-codecB.js";

const codec = createEventCodec();
const enc = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeBytes(bytes: Uint8Array, over: Partial<Parameters<typeof codec.encode>[0]> = {}) {
  return codec.encode({
    sessionId: "s1",
    seq: 1n,
    eventId: "e1",
    role: "user",
    kind: "message",
    bytes,
    occurredAtMs: 0n,
    ...over,
  });
}

describe("EventCodec strict UTF-8 classification", () => {
  test("valid ASCII decodes to text with derived NFC", () => {
    const cls = classifyUtf8(enc.encode("hello"));
    assert.equal(cls.valid, true);
    if (cls.valid) assert.equal(cls.text, "hello");
  });

  test("invalid ff fe classifies invalid and is never replaced with U+FFFD", () => {
    const cls = classifyUtf8(new Uint8Array([0xff, 0xfe]));
    assert.equal(cls.valid, false);
    if (!cls.valid) assert.equal(cls.base64, Buffer.from([0xff, 0xfe]).toString("base64"));
  });

  test("overlong c0 af is invalid (strict, no overlong acceptance)", () => {
    assert.equal(classifyUtf8(new Uint8Array([0xc0, 0xaf])).valid, false);
  });

  test("truncated multi-byte sequence is invalid", () => {
    // e-acute needs C3 A9; only C3 (lead byte with no continuation) is invalid.
    assert.equal(classifyUtf8(new Uint8Array([0xc3])).valid, false);
  });

  test("empty bytes are valid with empty text", () => {
    const cls = classifyUtf8(new Uint8Array(0));
    assert.equal(cls.valid, true);
    if (cls.valid) assert.equal(cls.text, "");
  });

  test("composed and decomposed e-acute both decode, NFC-normalize equal, digests differ", () => {
    const composed = encodeBytes(enc.encode("é"));
    const decomposed = encodeBytes(enc.encode("é"));
    assert.equal(composed.utf8.valid, true);
    assert.equal(decomposed.utf8.valid, true);
    assert.equal(composed.canonicalNfc, decomposed.canonicalNfc, "derived NFC coincides");
    assert.notEqual(composed.bytesDigest, decomposed.bytesDigest, "distinct byte identities");
    // decode never reconstructs from NFC.
    assert.ok(Buffer.from(codec.decode(composed)).equals(Buffer.from(enc.encode("é"))));
    assert.ok(Buffer.from(codec.decode(decomposed)).equals(Buffer.from(enc.encode("é"))));
  });
});

describe("EventCodec encode/decode byte contract", () => {
  test("decode(encode(bytes)).originalBytes === bytes for all byte arrays", () => {
    for (let n = 0; n < 256; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      const e = encodeBytes(bytes);
      assert.ok(Buffer.from(codec.decode(e)).equals(Buffer.from(bytes)), `round-trip ${n}`);
      assert.equal(e.bytesDigest, `sha256:${sha256(bytes)}`);
    }
  });

  test("canonicalNfc is derived only for valid UTF-8", () => {
    const invalid = encodeBytes(new Uint8Array([0xff, 0x00]));
    assert.equal(invalid.canonicalNfc, undefined, "no NFC for invalid bytes");
    const valid = encodeBytes(enc.encode("café"));
    assert.equal(valid.canonicalNfc, "café");
  });

  test("bytesDigest is sha256 over originalBytes (authoritative digest)", () => {
    const bytes = enc.encode("digest me");
    const e = encodeBytes(bytes);
    assert.equal(e.bytesDigest, `sha256:${sha256(bytes)}`);
  });

  test("tool result carries its toolCallId; policy role is preserved", () => {
    const res = encodeBytes(enc.encode("result"), { role: "tool", kind: "tool_result", toolCallId: "tc1" });
    assert.equal(res.role, "tool");
    assert.equal(res.toolCallId, "tc1");
    const pol = encodeBytes(enc.encode("[policy]"), { role: "policy", kind: "policy_input" });
    assert.equal(pol.role, "policy");
  });
});

describe("Mode B independence + parity", () => {
  test("B is byte-identical to A (digest + utf8 + NFC) but independently computed", () => {
    const samples = [enc.encode("plain"), new Uint8Array([0xff, 0xfe]), enc.encode("é"), enc.encode("é"), new Uint8Array(0)];
    for (const bytes of samples) {
      const a = encodeBytes(bytes);
      const b = recordRawBytesB(bytes);
      assert.equal(b.bytesDigest, a.bytesDigest, "A and B digest parity");
      assert.equal(b.utf8.valid, a.utf8.valid, "A and B utf8 parity");
      if (a.utf8.valid) assert.equal(b.canonicalNfc, a.canonicalNfc, "A and B NFC parity");
    }
  });
});
