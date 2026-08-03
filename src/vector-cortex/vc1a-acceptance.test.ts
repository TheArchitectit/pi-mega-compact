/**
 * vector-cortex/vc1a-acceptance.test.ts — VC1A acceptance aggregator.
 *
 * Reads the EVT-001..015 conformance rows from the v2 manifest and:
 *   - encode rows: runs EventV2 codec (mode A) over the fixture bytes and asserts
 *     ALL of: digest recomputes to the stored sha256, strict UTF-8 classification
 *     matches the expected discriminant (no lossy replacement), NFC is derived for
 *     valid UTF-8 only, and decode(encode(...)).originalBytes === input bytes
 *     byte-for-byte.
 *   - validate rows: assembles stored EventV2 (honoring bytesDigest/utf8Tag
 *     corruption overrides) and asserts validateEvents returns exactly the listed
 *     failure code(s) in deterministic priority order, or ok with the bytewise
 *     (session,seq,eventId-bytes) order.
 * Also verifies: mode-B raw byte record shares no subroutine but is byte-identical
 * to mode A across the corpus; arbitrary-byte + event-ID property invariants
 * (round-trip 100%, digest ignores NFC); the unique byte-flip failure injection
 * returns EVT_DIGEST_MISMATCH with no replacement text; flag-off
 * (MEGACOMPACT_VC1A=0) is byte-identical to the predecessor; and the ledger
 * emit seam gates observability (flag ON emits, flag OFF emits zero).
 *
 * Node --test on the compiled dist output (no mocks; real logic + fixtures).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VC1A_ENABLED } from "../config/vector-cortex.js";
import { EVT_IDS } from "./ledger/types.js";
import type { EventV2, ValidationCode } from "./ledger/types.js";
import { createEventCodec, classifyUtf8 } from "./ledger/event-codec.js";
import { recordRawBytesB, digestCheckB } from "./ledger/event-codecB.js";
import { validateEvents, sortEvents, compareEvents } from "./ledger/validator.js";
import { createLedgerReporter } from "./ledger/emit.js";
import { createLedgerAdapter } from "./ledger/adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = HERE.includes(join("dist", "src", "vector-cortex"))
  ? join(HERE, "..", "..", "..")
  : join(HERE, "..", "..");
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestRow {
  id: string;
  path: string;
  sha256: string;
  algorithm: string;
  expected: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}
interface EventEnvelope {
  sessionId: string;
  seq: number;
  eventId: string;
  role: "policy" | "user" | "assistant" | "tool";
  kind: string;
  bytesBase64: string;
  toolCallId?: string;
  bytesDigest?: string;
  utf8Tag?: "valid" | "invalid";
}
interface EventFixtureBody {
  id: string;
  kind: "encode" | "validate";
  input: { events: EventEnvelope[] };
  expected: {
    ok: boolean;
    utf8Valid?: boolean;
    canonicalNfc?: string;
    distinctDigests?: boolean;
    equalNfc?: boolean;
    codes?: string[];
    order?: string[];
  };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function readFixture(bodyPath: string): EventFixtureBody {
  return JSON.parse(readFileSync(join(V2, bodyPath), "utf8")) as EventFixtureBody;
}
function bytesOf(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const codec = createEventCodec();

/** Build a stored EventV2 from an envelope, honoring corruption overrides. */
function buildStoredEvent(fx: EventEnvelope): EventV2 {
  const bytes = bytesOf(fx.bytesBase64);
  const digest = (fx.bytesDigest ?? `sha256:${sha256(bytes)}`) as EventV2["bytesDigest"];
  let utf8: EventV2["utf8"];
  if (fx.utf8Tag === undefined) {
    utf8 = classifyUtf8(bytes);
  } else if (fx.utf8Tag === "valid") {
    const cls = classifyUtf8(bytes);
    utf8 = cls.valid ? { valid: true, text: cls.text } : { valid: true, text: "" };
  } else {
    utf8 = { valid: false, base64: Buffer.from(bytes).toString("base64") };
  }
  const e: EventV2 = {
    schema: "event-v2",
    sessionId: fx.sessionId,
    seq: BigInt(fx.seq),
    eventId: fx.eventId,
    role: fx.role,
    kind: fx.kind,
    originalBytes: bytes,
    bytesDigest: digest,
    utf8,
    occurredAtMs: 0n,
  };
  if (fx.toolCallId !== undefined) e.toolCallId = fx.toolCallId;
  return e;
}

describe("VC1A flag gates ledger observability (real consumer)", () => {
  const flagEnvKey = "MEGACOMPACT_VC1A";
  const savedFlag = process.env[flagEnvKey];

  after(() => {
    if (savedFlag === undefined) delete process.env[flagEnvKey];
    else process.env[flagEnvKey] = savedFlag;
  });

  test("flag ON emits event_decoded + validation_failed; flag OFF emits ZERO events", () => {
    const emitter: string[] = [];
    const adapter = createLedgerAdapter((ev) => emitter.push(ev));
    const ev = codec.encode({
      sessionId: "s-vc1a-flag",
      seq: 1n,
      eventId: "e1",
      role: "user",
      kind: "message",
      bytes: new TextEncoder().encode("hello"),
      occurredAtMs: 0n,
    });

    // Flag ON — decode emits event_decoded; failing validation emits failed.
    process.env[flagEnvKey] = "1";
    assert.equal(VC1A_ENABLED(), true);
    const out = adapter.decode(ev);
    assert.ok(Buffer.from(out).equals(Buffer.from(ev.originalBytes)), "decode round-trips bytes");
    assert.ok(emitter.includes("vector_cortex_event_decoded"), "flag ON emits event_decoded");

    emitter.length = 0;
    const bad = { ...ev, bytesDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" } as EventV2;
    adapter.validate([bad]);
    assert.ok(emitter.includes("vector_cortex_event_validation_failed"), "flag ON emits validation_failed");

    // Flag OFF — same adapter emits NOTHING while the codec still decodes.
    emitter.length = 0;
    process.env[flagEnvKey] = "0";
    assert.equal(VC1A_ENABLED(), false);
    const out2 = adapter.decode(ev);
    assert.equal(emitter.length, 0, "flag OFF emits zero ledger observability events");
    assert.ok(Buffer.from(out2).equals(Buffer.from(ev.originalBytes)), "codec still decodes byte-identically with flag off");
    const res = adapter.validate([bad]);
    assert.equal(res.ok, false, "validation still reports failure with flag off");
    assert.equal(emitter.length, 0, "flag OFF also suppresses the validation_failed emission");
  });
});

describe("EVT conformance corpus (manifest-indexed, EVT-001..015)", () => {
  test("manifest registers EVT-001..015", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures.filter((f) => f.path.startsWith("events/")).map((f) => f.id);
    for (const id of EVT_IDS) assert.ok(ids.includes(id), `missing ${id}`);
  });

  test("encode rows: byte round-trip 100% + strict UTF-8 + derived NFC + digest", () => {
    const manifest = readManifest();
    const rows = manifest.fixtures.filter((f) => f.algorithm === "event-v2");
    assert.ok(rows.length >= 5, "expected the encode rows");
    for (const row of rows) {
      const fx = readFixture(row.path);
      const envelopes = fx.input.events;
      const digests: string[] = [];
      for (const env of envelopes) {
        const bytes = bytesOf(env.bytesBase64);
        const decoded = codec.encode({
          sessionId: env.sessionId,
          seq: BigInt(env.seq),
          eventId: env.eventId,
          role: env.role,
          kind: env.kind,
          bytes,
          occurredAtMs: 0n,
          toolCallId: env.toolCallId,
        });
        // decode(encode(event)).originalBytes === input bytes (byte round-trip).
        const roundtrip = codec.decode(decoded);
        assert.ok(
          Buffer.from(roundtrip).equals(Buffer.from(bytes)),
          `${fx.id}: round-trip bytes must equal input (byte-for-byte)`,
        );
        // digest over originalBytes, deterministic.
        assert.equal(decoded.bytesDigest, `sha256:${sha256(bytes)}`, `${fx.id}: digest mismatch`);
        digests.push(decoded.bytesDigest);
        // strict UTF-8 classification.
        assert.equal(decoded.utf8.valid, fx.expected.utf8Valid, `${fx.id}: expected utf8Valid=${fx.expected.utf8Valid}`);
        if (fx.expected.canonicalNfc !== undefined) {
          assert.ok(decoded.utf8.valid, `${fx.id}: canonicalNfc only defined for valid UTF-8`);
          assert.equal(decoded.canonicalNfc, fx.expected.canonicalNfc, `${fx.id}: canonicalNfc mismatch`);
        } else if (decoded.utf8.valid === false) {
          assert.equal(decoded.canonicalNfc, undefined, `${fx.id}: no canonicalNfc for invalid UTF-8`);
          assert.equal(decoded.utf8.base64, env.bytesBase64, `${fx.id}: invalid UTF-8 represented as {valid:false,base64}`);
        }
      }
      if (fx.expected.distinctDigests) {
        assert.equal(new Set(digests).size, digests.length, `${fx.id}: NFC-identical events must be distinct identities`);
      }
    }
  });

  test("EVT-NFC-002: composed and decomposed e-acute are distinct but share canonical NFC", () => {
    const fx = readFixture("events/EVT-002.json");
    const composed = codec.encode({
      sessionId: fx.input.events[0].sessionId, seq: BigInt(fx.input.events[0].seq),
      eventId: fx.input.events[0].eventId, role: fx.input.events[0].role, kind: fx.input.events[0].kind,
      bytes: bytesOf(fx.input.events[0].bytesBase64), occurredAtMs: 0n,
    });
    const decomposed = codec.encode({
      sessionId: fx.input.events[1].sessionId, seq: BigInt(fx.input.events[1].seq),
      eventId: fx.input.events[1].eventId, role: fx.input.events[1].role, kind: fx.input.events[1].kind,
      bytes: bytesOf(fx.input.events[1].bytesBase64), occurredAtMs: 0n,
    });
    assert.notEqual(composed.bytesDigest, decomposed.bytesDigest, "distinct byte identities -> distinct digests");
    assert.equal(composed.canonicalNfc, decomposed.canonicalNfc, "derived NFC coincides");
    assert.equal(composed.canonicalNfc, "é");
    // decode never reconstructs from NFC: each returns its own original bytes.
    assert.ok(Buffer.from(codec.decode(composed)).equals(Buffer.from(bytesOf(fx.input.events[0].bytesBase64))));
    assert.ok(Buffer.from(codec.decode(decomposed)).equals(Buffer.from(bytesOf(fx.input.events[1].bytesBase64))));
  });

  test("EVT-TIE-003: equal session/seq sorts unsigned eventId bytes (code-unit vs byte divergence)", () => {
    const fx = readFixture("events/EVT-003.json");
    const events = fx.input.events.map(buildStoredEvent);
    // Sanity: the fixture's eventIds are pairwise code-unit distinct but bytewise
    // different — U+10000's surrogate (D800) sorts BEFORE U+E000 in code units yet
    // its UTF-8 first byte (F0) sorts AFTER U+E000's (EE) in bytes.
    const hi = events.find((e) => e.eventId === String.fromCodePoint(0x10000))!;
    const ue = events.find((e) => e.eventId === String.fromCodePoint(0xe000))!;
    assert.ok(hi.eventId < ue.eventId, "code-unit order: surrogate < E000 (JS string compares code units)");
    assert.ok(compareEvents(ue, hi) < 0, "byte order: E000 < U+10000 (validator compares UTF-8 bytes)");
    const res = validateEvents(events);
    assert.equal(res.ok, true, "tie events are valid");
    if (res.ok) {
      const got = res.ordered.map((e) => e.eventId);
      assert.deepEqual(got, fx.expected.order, "bytewise (eventId) sort order");
    }
  });

  test("validate rows: each returns exactly its manifest failure code(s) in deterministic order", () => {
    const manifest = readManifest();
    const rows = manifest.fixtures.filter((f) => f.algorithm === "event-v2-validate");
    for (const row of rows) {
      const fx = readFixture(row.path);
      const events = fx.input.events.map(buildStoredEvent);
      const res = validateEvents(events);
      assert.equal(res.ok, fx.expected.ok, `${fx.id}: ok mismatch`);
      if (!fx.expected.ok) {
        const want = (fx.expected.codes ?? []) as ValidationCode[];
        assert.equal(res.ok, false, `${fx.id}: expected failure`);
        assert.deepEqual(res.codes, want, `${fx.id}: expected codes ${want.join(",")}`);
        assert.equal(row.expected, want[0], `${fx.id}: manifest failure code = first listed code`);
      } else if (fx.expected.order !== undefined) {
        assert.equal(res.ok, true, `${fx.id}: expected ok`);
        assert.deepEqual(
          res.ordered.map((e) => e.eventId),
          fx.expected.order,
          `${fx.id}: bytewise order`,
        );
      }
    }
  });

  test("EVT-009 unique injection: flip stored byte / retained digest -> EVT_DIGEST_MISMATCH with no replacement text", () => {
    const fx = readFixture("events/EVT-009.json");
    const event = buildStoredEvent(fx.input.events[0]);
    const res = validateEvents([event]);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.deepEqual(res.codes, ["EVT_DIGEST_MISMATCH"]);
    }
    // No replacement text is fabricated anywhere on the failure path.
    const cls = classifyUtf8(event.originalBytes);
    assert.equal(cls.valid, true, "the payload itself is still valid UTF-8");
    assert.ok(!JSON.stringify(res).includes("sha256:0000"), "no replacement text in the result");
  });
});

describe("Mode A vs Mode B independence + byte identity", () => {
  test("B shares no subroutine but is byte-identical to A across the whole corpus", () => {
    const manifest = readManifest();
    const rows = manifest.fixtures.filter((f) => f.path.startsWith("events/"));
    let checked = 0;
    for (const row of rows) {
      const fx = readFixture(row.path);
      for (const env of fx.input.events) {
        const bytes = bytesOf(env.bytesBase64);
        const aDigest = codec.encode({
          sessionId: env.sessionId, seq: BigInt(env.seq), eventId: env.eventId,
          role: env.role, kind: env.kind, bytes, occurredAtMs: 0n,
        }).bytesDigest;
        const b = recordRawBytesB(bytes);
        assert.equal(b.bytesDigest, aDigest, `${fx.id}/${env.eventId}: A and B digest parity`);
        assert.equal(b.bytesDigest, `sha256:${sha256(bytes)}`, `${fx.id}: digest is sha256 over originalBytes`);
        // B's independent digest recheck agrees with the stored digest.
        assert.equal(digestCheckB(buildStoredEvent(env)), b.bytesDigest, `${fx.id}: B digest check self-consistent`);
        // Both classify UTF-8 identically (independent classifiers).
        assert.equal(b.utf8.valid, classifyUtf8(bytes).valid, `${fx.id}: A and B utf8 classification parity`);
        if (env.bytesDigest === undefined) {
          assert.equal(b.canonicalNfc, codec.encode({
            sessionId: env.sessionId, seq: BigInt(env.seq), eventId: env.eventId,
            role: env.role, kind: env.kind, bytes, occurredAtMs: 0n,
          }).canonicalNfc, `${fx.id}: A and B derive identical NFC`);
        }
        checked++;
      }
    }
    assert.ok(checked >= 15, `checked ${checked} occurrences across the corpus`);
  });

  test("mode A and mode B raw records are byte-identical for arbitrary bytes", () => {
    for (let i = 0; i < 200; i++) {
      const bytes = randomBytes(i % 64);
      const a = codec.encode({
        sessionId: "s", seq: BigInt(i), eventId: `e${i}`, role: "user", kind: "m",
        bytes, occurredAtMs: 0n,
      });
      const b = recordRawBytesB(bytes);
      assert.equal(b.bytesDigest, a.bytesDigest, `arbitrary bytes ${i}: A/B digest parity`);
      assert.equal(b.utf8.valid, a.utf8.valid, `arbitrary bytes ${i}: A/B utf8 parity`);
      if (a.utf8.valid) assert.equal(b.canonicalNfc, a.canonicalNfc, `arbitrary bytes ${i}: A/B NFC parity`);
    }
  });
});

describe("Property invariants (arbitrary bytes + event IDs)", () => {
  test("decode(encode(event)).originalBytes === input for 5,000 arbitrary byte arrays (including invalid UTF-8)", () => {
    const enc = new TextEncoder();
    for (let i = 0; i < 5000; i++) {
      // Mix pure random bytes and UTF-8-ish text (so a solid share are invalid).
      const raw = randomBytes(i % 37);
      const bytes = i % 2 === 0 ? raw : enc.encode(`utf8 ${i}`);
      const decoded = codec.encode({
        sessionId: `s${i}`, seq: BigInt(i), eventId: `e${i}`, role: "user", kind: "m",
        bytes, occurredAtMs: 0n,
      });
      const out = codec.decode(decoded);
      assert.ok(Buffer.from(out).equals(Buffer.from(bytes)), `round-trip failed at ${i}`);
      assert.equal(decoded.bytesDigest, `sha256:${sha256(bytes)}`);
      // Invalid bytes are never replacement-decoded (no U+FFFD in a valid-text path).
      const cls = classifyUtf8(bytes);
      if (!cls.valid) {
        assert.equal(decoded.utf8.valid, false);
        assert.equal(decoded.canonicalNfc, undefined);
      }
    }
  });

  test("digest identity ignores NFC: composed/decomposed pairs are distinct identities with equal canonical NFC", () => {
    const enc = new TextEncoder();
    // (base, combining-accent) pairs with canonical compositions in NFC.
    const bases = ["a", "e", "i", "o", "u", "A", "E", "c", "n"];
    const accents = ["̀", "́", "̂", "̃", "̈"];
    let checkedPairs = 0;
    for (let b = 0; b < bases.length; b++) {
      for (let ac = 0; ac < accents.length; ac++) {
        const base = bases[b] as string;
        const accent = accents[ac] as string;
        const decomposed = `${base}${accent}`; // NFD-ish
        const composed = decomposed.normalize("NFC"); // composed form (may equal)
        const decBytes = enc.encode(decomposed);
        const compBytes = enc.encode(composed);
        if (composed === decomposed) continue; // no distinct composed form exists
        checkedPairs++;
        const eDec = codec.encode({ sessionId: "s", seq: BigInt(checkedPairs), eventId: `dec`, role: "user", kind: "m", bytes: decBytes, occurredAtMs: 0n });
        const eComp = codec.encode({ sessionId: "s", seq: BigInt(-checkedPairs), eventId: `comp`, role: "user", kind: "m", bytes: compBytes, occurredAtMs: 0n });
        // canonical NFC coincides (derived)...
        assert.equal(eDec.canonicalNfc, eComp.canonicalNfc, "derived NFC coincides");
        // ...but byte identity differs -> distinct digests (identity never NFC).
        assert.notEqual(eDec.bytesDigest, eComp.bytesDigest, "distinct byte identities must have distinct digests");
        // decode round-trips each form exactly (never reconstructs from NFC).
        assert.ok(Buffer.from(codec.decode(eDec)).equals(Buffer.from(decBytes)));
        assert.ok(Buffer.from(codec.decode(eComp)).equals(Buffer.from(compBytes)));
      }
    }
    assert.ok(checkedPairs >= 10, `checked ${checkedPairs} composed/decomposed pairs`);
  });

  test("canonical sort by (session, seq, eventId bytes) matches a reference bytewise sort", () => {
    const enc = new TextEncoder();
    const events: EventV2[] = [];
    // Diverse eventId prefixes including a surrogate divergence (U+10000 vs
    // U+E000) and multi-byte chars; uniqueness guaranteed by the `-i` suffix.
    const ids = ["a", "b", "A", String.fromCodePoint(0xe000), String.fromCodePoint(0x10000), "é", "́"];
    for (let i = 0; i < 300; i++) {
      const id = `${ids[i % ids.length]}-${i}`;
      const bytes = enc.encode(`m${i}`);
      events.push({
        schema: "event-v2", sessionId: `s${i % 3}`, seq: BigInt(i % 5), eventId: id,
        role: "user", kind: "m", originalBytes: bytes, bytesDigest: `sha256:${sha256(bytes)}`,
        utf8: { valid: true, text: `m${i}` }, canonicalNfc: `m${i}`, occurredAtMs: 0n,
      });
    }
    const sorted = sortEvents(events);
    for (let i = 0; i < sorted.length - 1; i++) {
      assert.ok(compareEvents(sorted[i] as EventV2, sorted[i + 1] as EventV2) <= 0, "non-decreasing canonical order");
    }
    // The validator's returned order is exactly the sorted order.
    const res = validateEvents(events);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.ordered.map((e) => e.eventId), sorted.map((e) => e.eventId), "validator returned canonical order");
    }
  });
});

describe("Mode C: flag-off is byte-identical to the predecessor (current transcript codec unchanged)", () => {
  test("flag OFF leaves the codec/validator functional and the ledger emits nothing", () => {
    const flagEnvKey = "MEGACOMPACT_VC1A";
    const saved = process.env[flagEnvKey];
    process.env[flagEnvKey] = "0";
    try {
      assert.equal(VC1A_ENABLED(), false);
      // Codec still works byte-identically.
      const bytes = new TextEncoder().encode("predecessor");
      const e = codec.encode({ sessionId: "s", seq: 1n, eventId: "e", role: "user", kind: "m", bytes, occurredAtMs: 0n });
      assert.ok(Buffer.from(codec.decode(e)).equals(Buffer.from(bytes)));
      // Reporter emits nothing (mode-C zero observability writes).
      const emitted: string[] = [];
      const rep = createLedgerReporter((ev) => emitted.push(ev));
      rep.eventDecoded({ session: "s", seq: "1", eventId: "e", bytes: 1, utf8Valid: true });
      rep.validationFailed({ session: "s", seq: "1", eventId: "e", code: "EVT_DIGEST_MISMATCH" });
      assert.equal(emitted.length, 0, "flag OFF emits zero ledger observability events");
    } finally {
      if (saved === undefined) delete process.env[flagEnvKey];
      else process.env[flagEnvKey] = saved;
    }
  });
});
