/**
 * vector-cortex/ledger/validator.test.ts — EventV2 canonical validator tests
 * (VC1A).
 *
 * Real logic, no mocks. Covers: canonical (sessionId, seq, eventId-bytes) sort,
 * deterministic failure codes (EVT_DIGEST_MISMATCH / EVT_UTF8_TAG_INVALID /
 * EVT_DUPLICATE_ID), the unique byte-flip failure injection (retained digest +
 * flipped byte -> EVT_DIGEST_MISMATCH, no replacement text), fixed priority order
 * for mixed failures, and newsort-of-duplicate detection.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateEvents, sortEvents, compareEvents, compareEventIdBytes } from "./validator.js";
import { createEventCodec, classifyUtf8 } from "./event-codec.js";
import { recordRawBytesB } from "./event-codecB.js";
import type { EventV2 } from "./types.js";

const codec = createEventCodec();
const enc = new TextEncoder();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function stored(bytes: Uint8Array, over: Partial<EventV2> = {}): EventV2 {
  const cls = classifyUtf8(bytes);
  return {
    schema: "event-v2",
    sessionId: "s1",
    seq: 1n,
    eventId: "e1",
    role: "user",
    kind: "message",
    originalBytes: bytes,
    bytesDigest: `sha256:${sha256(bytes)}`,
    utf8: cls,
    occurredAtMs: 0n,
    ...over,
  } as EventV2;
}

describe("canonical sort (sessionId, seq, eventId bytewise UTF-8)", () => {
  test("sorts by sessionId, then seq, then eventId bytes", () => {
    const events: EventV2[] = [
      stored(enc.encode("b"), { sessionId: "s2", seq: 1n, eventId: "a" }),
      stored(enc.encode("a"), { sessionId: "s1", seq: 2n, eventId: "z" }),
      stored(enc.encode("c"), { sessionId: "s1", seq: 1n, eventId: "b" }),
    ];
    const sorted = sortEvents(events);
    assert.deepEqual(sorted.map((e) => [e.sessionId, e.seq, e.eventId]), [
      ["s1", 1n, "b"],
      ["s1", 2n, "z"],
      ["s2", 1n, "a"],
    ]);
  });

  test("eventId compares by UTF-8 BYTES, not JS code units (surrogate divergence)", () => {
    const hi = String.fromCodePoint(0x10000); // surrogate D800, UTF-8 F0...
    const ue = String.fromCodePoint(0xe000); // code unit E000, UTF-8 EE...
    // JS code-unit order puts the surrogate FIRST; byte order puts E000 FIRST.
    assert.ok(hi < ue, "JS: surrogate < E000");
    assert.ok(compareEventIdBytes(ue, hi) < 0, "validator: E000 < U+10000 (bytewise)");
    const sorted = sortEvents([
      stored(enc.encode("h"), { eventId: hi }),
      stored(enc.encode("u"), { eventId: ue }),
    ]);
    assert.deepEqual(sorted.map((e) => e.eventId), [ue, hi]);
  });

  test("compareEvents is a total order (reflexivity + transitivity)", () => {
    const a = stored(enc.encode("x"), { sessionId: "s", seq: 1n, eventId: "m" });
    const b = stored(enc.encode("y"), { sessionId: "s", seq: 1n, eventId: "n" });
    const c = stored(enc.encode("z"), { sessionId: "s", seq: 2n, eventId: "a" });
    assert.equal(compareEvents(a, a), 0);
    assert.ok(compareEvents(a, b) < 0);
    assert.ok(compareEvents(b, c) < 0);
    assert.ok(compareEvents(a, c) < 0);
  });
});

describe("digest validation", () => {
  test("valid event passes; flipped byte with retained digest -> EVT_DIGEST_MISMATCH", () => {
    const bytes = enc.encode("payload bytes");
    const good = stored(bytes);
    assert.equal(validateEvents([good]).ok, true);

    // Flip one stored ASCII byte ('p' -> 'q'), RETAIN the original digest (now
    // stale because it still covers the pre-flip bytes), and keep the utf8 tag
    // consistent with the corrupted bytes. The digest check is therefore the SOLE
    // failure -> EVT_DIGEST_MISMATCH, with no replacement text fabricated anywhere.
    const flippedBytes = new Uint8Array([...bytes.slice(0, 1), 0x71, ...bytes.slice(2)]);
    const flipped = {
      ...good,
      originalBytes: flippedBytes,
      utf8: { valid: true, text: new TextDecoder("utf-8").decode(flippedBytes) },
    } as EventV2;
    const res = validateEvents([flipped]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_DIGEST_MISMATCH"]);
  });

  test("corrupted stored digest -> EVT_DIGEST_MISMATCH", () => {
    const bad = stored(enc.encode("ok"), { bytesDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" });
    const res = validateEvents([bad]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_DIGEST_MISMATCH"]);
  });
});

describe("UTF-8 tag validation", () => {
  test("tag claims invalid but bytes are valid UTF-8 -> EVT_UTF8_TAG_INVALID", () => {
    const bytes = enc.encode("plain ascii");
    const bad = { ...stored(bytes), utf8: { valid: false, base64: Buffer.from(bytes).toString("base64") } } as EventV2;
    const res = validateEvents([bad]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_UTF8_TAG_INVALID"]);
  });

  test("tag claims valid but bytes are invalid UTF-8 -> EVT_UTF8_TAG_INVALID", () => {
    const bad = { ...stored(new Uint8Array([0xff, 0x00])), utf8: { valid: true, text: "" } } as EventV2;
    const res = validateEvents([bad]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_UTF8_TAG_INVALID"]);
  });
});

describe("duplicate detection", () => {
  test("duplicate (sessionId, seq, eventId) -> EVT_DUPLICATE_ID", () => {
    const a = stored(enc.encode("first"));
    const b = stored(enc.encode("first"));
    const res = validateEvents([a, b]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_DUPLICATE_ID"]);
  });

  test("equal bytes with different eventId or seq are NOT duplicates", () => {
    const a = stored(enc.encode("same"));
    const b = stored(enc.encode("same"), { eventId: "e2" });
    const c = stored(enc.encode("same"), { seq: 2n });
    const d = stored(enc.encode("same"), { sessionId: "s2" });
    const res = validateEvents([a, b, c, d]);
    assert.equal(res.ok, true, "distinct occurrences, no duplicate");
  });
});

describe("deterministic mixed failure priority", () => {
  test("digest mismatch + duplicate surface as [EVT_DIGEST_MISMATCH, EVT_DUPLICATE_ID]", () => {
    const bad = stored(enc.encode("x"), { bytesDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const dupA = stored(enc.encode("dup"), { seq: 2n, eventId: "dup" });
    const dupB = stored(enc.encode("dup"), { seq: 2n, eventId: "dup" });
    const res = validateEvents([bad, dupA, dupB]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_DIGEST_MISMATCH", "EVT_DUPLICATE_ID"]);
  });

  test("byte-flip to invalid UTF-8 with retained original digest -> digest mismatch + utf8 tag invalid", () => {
    // Original valid "aa"; retained digest; stored bytes flipped to invalid ff 00.
    const retained = `sha256:${sha256(enc.encode("aa"))}`;
    const bad = {
      ...stored(new Uint8Array([0xff, 0x00])),
      bytesDigest: retained,
      utf8: { valid: true, text: "" },
    } as EventV2;
    const res = validateEvents([bad]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.codes, ["EVT_DIGEST_MISMATCH", "EVT_UTF8_TAG_INVALID"]);
    // B (independent digest check) agrees the retained digest no longer matches.
    assert.notEqual(recordRawBytesB(new Uint8Array([0xff, 0x00])).bytesDigest, retained);
  });
});

describe("byte-identity round-trip through the validator", () => {
  test("codec-encoded events always validate ok and decode to their exact bytes", () => {
    for (let n = 0; n < 64; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 13 + 5) & 255);
      const e = codec.encode({
        sessionId: "s", seq: BigInt(n), eventId: `e${n}`, role: "user", kind: "m",
        bytes, occurredAtMs: 0n,
      });
      const res = validateEvents([e]);
      assert.equal(res.ok, true, `encoded event ${n} must always validate`);
      assert.ok(Buffer.from(codec.decode(e)).equals(Buffer.from(bytes)));
    }
  });
});
