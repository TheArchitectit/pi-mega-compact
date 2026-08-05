/**
 * heal/vc6b-triad.test.ts — forced A/B/C mode triad.
 *
 * A = indexed exact shard serves the restoration.
 * B = missing exact index forces the INDEPENDENT ledger range scan.
 * C = neither source exists — the span is OMITTED and the loss disclosed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { EventV2, ExactShardV1, RestoreRequestV1, ShardRange } from "./restore-types.js";
import { enc, hex } from "./_vc6b-helpers.js";
import { restoreSources } from "./restore.js";
import { verifyRestored } from "./verify.js";

const range: ShardRange = {
  sessionId: "triad",
  seqStart: 1n,
  seqEnd: 1n,
  byteStart: 0,
  byteEnd: 5,
};
const bytes = enc("hello");
const digest = hex(bytes);
const request: RestoreRequestV1 = {
  schema: "restore-request-v1",
  sessionId: "triad",
  spans: [{ nodeId: "n1", range, digest }],
};
const shard: ExactShardV1 = {
  schema: "exact-shard-v1",
  sessionId: "triad",
  range,
  kind: "exact",
  originalBytes: bytes,
  digest,
  byteCount: bytes.length,
  case: "anchor",
};
const event: EventV2 = {
  schema: "event-v2",
  sessionId: "triad",
  seq: 1n,
  eventId: "e1",
  role: "user",
  kind: "message",
  originalBytes: bytes,
  bytesDigest: `sha256:${digest}`,
  utf8: { valid: true, text: "hello" },
  occurredAtMs: 1n,
};

describe("VC6B acceptance: forced A/B/C triad", () => {
  test("A: an indexed exact shard serves the restoration", () => {
    const r = restoreSources(request, { exactShards: [shard], ledgerEvents: [event] });
    assert.equal(r.mode, "A");
    assert.equal(r.restored[0]!.source, "exact-shard");
    assert.equal(verifyRestored(r, request).ok, true);
  });

  test("B: a missing exact index forces the INDEPENDENT ledger range scan", () => {
    const r = restoreSources(request, { exactShards: [], ledgerEvents: [event] });
    assert.equal(r.mode, "B");
    assert.equal(r.restored[0]!.source, "ledger-scan");
    assert.deepEqual(r.restored[0]!.bytes, bytes, "B produces byte-identical output to A");
    assert.equal(verifyRestored(r, request).ok, true);
  });

  test("C: neither source exists — the span is OMITTED and the loss disclosed", () => {
    const r = restoreSources(request, { exactShards: [], ledgerEvents: [] });
    assert.equal(r.mode, "C");
    assert.equal(r.restored.length, 0, "nothing fabricated from a derived source");
    assert.deepEqual(r.missing, ["n1"]);
    assert.equal(r.semanticLossStated, true, "C states its semantic loss");
    assert.ok(r.codes.includes("HEAL_RESTORE_SOURCE_MISSING"));
  });
});
