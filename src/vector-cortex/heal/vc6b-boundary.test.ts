/**
 * heal/vc6b-boundary.test.ts — disjoint spans + arbitrary payloads + limit boundary.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { ExactShardV1, RestoreReader, RestoreRequestV1, ShardRange } from "./restore-types.js";
import { RESTORE_LIMIT_SPANS } from "./restore-types.js";
import { hex } from "./_vc6b-helpers.js";
import { restoreSources } from "./restore.js";
import { verifyRestored } from "./verify.js";

function disjoint(n: number): {
  request: RestoreRequestV1;
  reader: RestoreReader;
} {
  const shards: ExactShardV1[] = [];
  const spans = Array.from({ length: n }, (_v, i) => {
    const payload = new Uint8Array([i & 0xff, 0x80, 0xff, (i * 7) & 0xff]);
    const range: ShardRange = {
      sessionId: "disjoint",
      seqStart: BigInt(i + 1),
      seqEnd: BigInt(i + 1),
      byteStart: i * 4,
      byteEnd: i * 4 + 4,
    };
    shards.push({
      schema: "exact-shard-v1",
      sessionId: "disjoint",
      range,
      kind: "exact",
      originalBytes: payload,
      digest: hex(payload),
      byteCount: payload.length,
      case: "invalid-utf8",
    });
    return { nodeId: `n${i}`, range, digest: hex(payload) };
  });
  return {
    request: { schema: "restore-request-v1", sessionId: "disjoint", spans },
    reader: { exactShards: shards, ledgerEvents: [] },
  };
}

describe("VC6B acceptance: disjoint spans + arbitrary payloads", () => {
  test(`${RESTORE_LIMIT_SPANS} disjoint spans at the boundary all restore byte-identically`, () => {
    const { request, reader } = disjoint(RESTORE_LIMIT_SPANS);
    const result = restoreSources(request, reader);
    assert.equal(result.mode, "A");
    assert.equal(result.restored.length, RESTORE_LIMIT_SPANS);
    assert.deepEqual(result.codes, []);
    assert.equal(verifyRestored(result, request).ok, true);
    for (let i = 0; i < RESTORE_LIMIT_SPANS; i++) {
      assert.deepEqual(result.restored[i]!.bytes, reader.exactShards[i]!.originalBytes);
    }
  });

  test("70 disjoint spans exceed the limit and are rejected before any read", () => {
    const { request } = disjoint(70);
    const result = restoreSources(request, { exactShards: [], ledgerEvents: [] });
    assert.deepEqual(result.codes, ["HEAL_RESTORE_LIMIT"]);
    assert.equal(result.mode, "C");
    assert.equal(result.restored.length, 0);
    assert.equal(result.missing.length, 70);
  });
});
