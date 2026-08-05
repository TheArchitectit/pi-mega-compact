/**
 * heal/vc6b-byte-identity.test.ts — byte-identity + insertion invariants.
 *
 * Every restored span's bytes must equal the ORIGINAL source bytes exactly,
 * and every insertion carries a digest that was VERIFIED against the request.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RESTORE_IDS, RESTORE_NAMED_IDS } from "./restore-types.js";
import { restorationFixture, decodeRange } from "./_restore-fixture.js";
import { runReal, hex } from "./_vc6b-helpers.js";
import { insertable } from "./verify.js";

const ALL_IDS = [...RESTORE_IDS, ...RESTORE_NAMED_IDS];

describe("VC6B acceptance: byte-identity invariant", () => {
  test("every restored span's bytes equal the ORIGINAL source bytes exactly", () => {
    for (const id of ALL_IDS) {
      const fx = restorationFixture(id);
      const { reader, result } = runReal(fx);
      for (const span of result.restored) {
        const range = decodeRange(
          fx.input.request.spans.find((s) => s.nodeId === span.nodeId)!.range,
        );
        const shard = reader.exactShards.find(
          (s) =>
            s.range.sessionId === range.sessionId &&
            s.range.seqStart === range.seqStart &&
            s.range.seqEnd === range.seqEnd &&
            s.range.byteStart === range.byteStart &&
            s.range.byteEnd === range.byteEnd,
        );
        if (span.source === "exact-shard") {
          assert.ok(shard, `${id}/${span.nodeId}: exact shard present`);
          assert.deepEqual(span.bytes, shard!.originalBytes, `${id}/${span.nodeId}: verbatim`);
        } else {
          const covering = reader.ledgerEvents
            .filter(
              (e) =>
                e.sessionId === range.sessionId &&
                e.seq >= range.seqStart &&
                e.seq <= range.seqEnd,
            )
            .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
          const expected = Buffer.concat(covering.map((e) => Buffer.from(e.originalBytes)));
          assert.deepEqual(
            Buffer.from(span.bytes),
            expected,
            `${id}/${span.nodeId}: ledger concat verbatim`,
          );
        }
      }
    }
  });

  test("every insertion carries a digest that was VERIFIED against the request", () => {
    for (const id of ALL_IDS) {
      const fx = restorationFixture(id);
      const { request, result } = runReal(fx);
      for (const span of insertable(result, request)) {
        const asked = request.spans.find((s) => s.nodeId === span.nodeId);
        assert.ok(asked, `${id}/${span.nodeId}: was requested`);
        assert.equal(span.digest, asked!.digest, `${id}/${span.nodeId}: digest is the requested one`);
        assert.equal(hex(span.bytes), asked!.digest, `${id}/${span.nodeId}: bytes hash to it`);
      }
    }
  });

  test("no failing fixture inserts anything for its failed spans", () => {
    for (const id of ALL_IDS) {
      const fx = restorationFixture(id);
      if (fx.expected.ok) continue;
      const { result } = runReal(fx);
      assert.equal(
        result.restored.length,
        fx.expected.restoredCount,
        `${id}: only the pinned count was inserted`,
      );
    }
  });
});
