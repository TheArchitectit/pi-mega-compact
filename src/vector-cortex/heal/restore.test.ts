/**
 * heal/restore.test.ts — VC6B `restoreSources` unit tests.
 *
 * Every input here is built with a REAL SHA-256 digest over the REAL bytes (see
 * `mkShard` / `mkEvent`), so a fixture can never accidentally pass by comparing
 * two equally-wrong values. No mocks: the readers under test are the production
 * readers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { EventV2, ExactShardV1, ShardRange } from "./restore-types.js";
import type { RestoreRequestV1 } from "./restore-types.js";
import { RESTORE_LIMIT_SPANS } from "./restore-types.js";
import { restoreSources } from "./restore.js";

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));
const hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function mkRange(
  sessionId: string,
  seqStart: number,
  seqEnd: number,
  byteStart = 0,
  byteEnd = 16,
): ShardRange {
  return {
    sessionId,
    seqStart: BigInt(seqStart),
    seqEnd: BigInt(seqEnd),
    byteStart,
    byteEnd,
  };
}

function mkShard(range: ShardRange, text: string): ExactShardV1 {
  const bytes = enc(text);
  return {
    schema: "exact-shard-v1",
    sessionId: range.sessionId,
    range,
    kind: "exact",
    originalBytes: bytes,
    digest: hex(bytes),
    byteCount: bytes.length,
    case: "anchor",
  };
}

function mkEvent(sessionId: string, seq: number, text: string): EventV2 {
  const bytes = enc(text);
  return {
    schema: "event-v2",
    sessionId,
    seq: BigInt(seq),
    eventId: `e${seq}`,
    role: "user",
    kind: "message",
    originalBytes: bytes,
    bytesDigest: `sha256:${hex(bytes)}`,
    utf8: { valid: true, text },
    occurredAtMs: BigInt(1000 + seq),
  };
}

function mkRequest(
  sessionId: string,
  spans: ReadonlyArray<{ nodeId: string; range: ShardRange; digest: string }>,
): RestoreRequestV1 {
  return { schema: "restore-request-v1", sessionId, spans };
}

describe("restoreSources: exact-shard reads (mode A)", () => {
  test("an indexed exact shard restores the original bytes verbatim", () => {
    const r = mkRange("s1", 1, 1);
    const shard = mkShard(r, "hello world");
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: shard.digest }]),
      { exactShards: [shard], ledgerEvents: [] },
    );
    assert.equal(result.mode, "A");
    assert.equal(result.restored.length, 1);
    assert.equal(result.restored[0]!.source, "exact-shard");
    assert.deepEqual(result.restored[0]!.bytes, enc("hello world"));
    assert.equal(result.missing.length, 0);
    assert.deepEqual(result.codes, []);
    assert.equal(result.semanticLossStated, false);
  });

  test("invalid UTF-8 bytes survive restoration unnormalized", () => {
    const raw = new Uint8Array([0x41, 0x80, 0xfe, 0xff, 0x42]);
    const r = mkRange("s1", 1, 1);
    const shard: ExactShardV1 = {
      schema: "exact-shard-v1",
      sessionId: "s1",
      range: r,
      kind: "exact",
      originalBytes: raw,
      digest: hex(raw),
      byteCount: raw.length,
      case: "invalid-utf8",
    };
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: shard.digest }]),
      { exactShards: [shard], ledgerEvents: [] },
    );
    assert.equal(result.mode, "A");
    assert.deepEqual(result.restored[0]!.bytes, raw);
  });
});

describe("restoreSources: ledger scan (mode B)", () => {
  test("falls through to a ledger scan when no exact shard covers the span", () => {
    const r = mkRange("s1", 1, 1);
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: hex(enc("hello")) }]),
      { exactShards: [], ledgerEvents: [mkEvent("s1", 1, "hello")] },
    );
    assert.equal(result.mode, "B");
    assert.equal(result.restored[0]!.source, "ledger-scan");
    assert.deepEqual(result.restored[0]!.bytes, enc("hello"));
  });

  test("multi-event spans concatenate in seq order regardless of input order", () => {
    const r = mkRange("s1", 1, 3);
    const events = [mkEvent("s1", 3, "ccc"), mkEvent("s1", 1, "aaa"), mkEvent("s1", 2, "bbb")];
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: hex(enc("aaabbbccc")) }]),
      { exactShards: [], ledgerEvents: events },
    );
    assert.equal(result.mode, "B");
    assert.deepEqual(result.restored[0]!.bytes, enc("aaabbbccc"));
  });

  test("events outside the seq range are excluded from the scan", () => {
    const r = mkRange("s1", 2, 2);
    const events = [mkEvent("s1", 1, "aaa"), mkEvent("s1", 2, "bbb"), mkEvent("s1", 3, "ccc")];
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: hex(enc("bbb")) }]),
      { exactShards: [], ledgerEvents: events },
    );
    assert.equal(result.mode, "B");
    assert.deepEqual(result.restored[0]!.bytes, enc("bbb"));
  });

  test("events from a different session are never scanned", () => {
    const r = mkRange("s1", 1, 1);
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: hex(enc("hello")) }]),
      { exactShards: [], ledgerEvents: [mkEvent("other", 1, "hello")] },
    );
    assert.equal(result.mode, "C");
    assert.deepEqual(result.missing, ["n1"]);
  });
});

describe("restoreSources: missing sources (mode C)", () => {
  test("a span no source covers is omitted and the loss is disclosed", () => {
    const known = mkRange("s1", 1, 1);
    const gone = mkRange("s1", 9, 9, 40, 45);
    const shard = mkShard(known, "alpha");
    const result = restoreSources(
      mkRequest("s1", [
        { nodeId: "n1", range: known, digest: shard.digest },
        { nodeId: "gone", range: gone, digest: hex(enc("ghost")) },
      ]),
      { exactShards: [shard], ledgerEvents: [] },
    );
    assert.equal(result.mode, "C");
    assert.equal(result.semanticLossStated, true);
    assert.equal(result.restored.length, 1);
    assert.deepEqual(result.missing, ["gone"]);
    assert.deepEqual(result.codes, ["HEAL_RESTORE_SOURCE_MISSING"]);
  });
});

describe("restoreSources: digest rejection", () => {
  test("a range-matching shard with the wrong digest is NOT inserted", () => {
    const r = mkRange("s1", 1, 1);
    const shard = mkShard(r, "actual-bytes");
    const result = restoreSources(
      // The request pins a digest over DIFFERENT bytes.
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: hex(enc("expected-bytes")) }]),
      { exactShards: [shard], ledgerEvents: [] },
    );
    assert.equal(result.mode, "C");
    assert.equal(result.restored.length, 0, "nothing inserted");
    assert.ok(result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"));
  });

  test("a shard whose bytes were swapped after indexing is rejected", () => {
    const r = mkRange("s1", 1, 1);
    const genuine = mkShard(r, "genuine");
    // Same recorded digest, different bytes — the "swap the file after lookup"
    // attack. The re-hash of originalBytes must catch it.
    const swapped: ExactShardV1 = { ...genuine, originalBytes: enc("swapped!") };
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: genuine.digest }]),
      { exactShards: [swapped], ledgerEvents: [] },
    );
    assert.equal(result.restored.length, 0, "nothing inserted");
    assert.ok(result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"));
  });

  test("a ledger record whose own bytesDigest is wrong rejects the span", () => {
    const r = mkRange("s1", 1, 1);
    const corrupt: EventV2 = {
      ...mkEvent("s1", 1, "hello"),
      bytesDigest: `sha256:${hex(enc("something-else"))}`,
    };
    const result = restoreSources(
      mkRequest("s1", [{ nodeId: "n1", range: r, digest: hex(enc("hello")) }]),
      { exactShards: [], ledgerEvents: [corrupt] },
    );
    assert.equal(result.restored.length, 0);
    assert.ok(result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"));
  });
});

describe("restoreSources: request bounds", () => {
  test("65 spans exceed RESTORE_LIMIT_SPANS and are rejected", () => {
    const spans = Array.from({ length: RESTORE_LIMIT_SPANS + 1 }, (_v, i) => ({
      nodeId: `n${i}`,
      range: mkRange("s1", i + 1, i + 1, i, i + 1),
      digest: hex(enc("x")),
    }));
    const result = restoreSources(mkRequest("s1", spans), {
      exactShards: [],
      ledgerEvents: [],
    });
    assert.deepEqual(result.codes, ["HEAL_RESTORE_LIMIT"]);
    assert.equal(result.mode, "C");
    assert.equal(result.restored.length, 0);
    assert.equal(result.missing.length, RESTORE_LIMIT_SPANS + 1);
    assert.equal(result.semanticLossStated, true);
  });

  test("a 64-span request at the boundary is accepted and restores", () => {
    const shards: ExactShardV1[] = [];
    const spans = Array.from({ length: RESTORE_LIMIT_SPANS }, (_v, i) => {
      const range = mkRange("s1", i + 1, i + 1, i, i + 1);
      const shard = mkShard(range, `p${i}`);
      shards.push(shard);
      return { nodeId: `n${i}`, range, digest: shard.digest };
    });
    const result = restoreSources(mkRequest("s1", spans), {
      exactShards: shards,
      ledgerEvents: [],
    });
    assert.equal(result.mode, "A");
    assert.equal(result.restored.length, RESTORE_LIMIT_SPANS);
    assert.deepEqual(result.codes, []);
  });

  test("an aggregate byte request over 4 MiB is rejected", () => {
    const spans = [0, 1, 2].map((i) => ({
      nodeId: `n${i}`,
      range: mkRange("s1", i + 1, i + 1, i * 2097152, (i + 1) * 2097152),
      digest: hex(enc("x")),
    }));
    const result = restoreSources(mkRequest("s1", spans), {
      exactShards: [],
      ledgerEvents: [],
    });
    assert.deepEqual(result.codes, ["HEAL_RESTORE_LIMIT"]);
    assert.equal(result.mode, "C");
  });

  test("bounds are checked BEFORE any reader is consulted", () => {
    // A getter that throws proves the reader is never touched on the limit path.
    let touched = false;
    const reader = {
      get exactShards(): ExactShardV1[] {
        touched = true;
        return [];
      },
      get ledgerEvents(): EventV2[] {
        touched = true;
        return [];
      },
    };
    const spans = Array.from({ length: RESTORE_LIMIT_SPANS + 1 }, (_v, i) => ({
      nodeId: `n${i}`,
      range: mkRange("s1", i + 1, i + 1, i, i + 1),
      digest: hex(enc("x")),
    }));
    const result = restoreSources(mkRequest("s1", spans), reader);
    assert.deepEqual(result.codes, ["HEAL_RESTORE_LIMIT"]);
    assert.equal(touched, false, "no reader property was read");
  });
});
