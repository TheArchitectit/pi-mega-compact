/**
 * heal/vc6b-failure-injection.test.ts — unique failure injection tests.
 *
 * Swapping bytes after an index lookup resolves, or swapping a ledger record's
 * content while keeping its per-record digest consistent, must be caught.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { EventV2, ExactShardV1 } from "./restore-types.js";
import { restorationFixture } from "./_restore-fixture.js";
import { decodeFx, enc, hex } from "./_vc6b-helpers.js";
import { restoreSources } from "./restore.js";
import { insertable } from "./verify.js";

describe("VC6B acceptance: UNIQUE failure injection", () => {
  test("swapping an exact shard's bytes AFTER lookup yields HEAL_RESTORE_DIGEST_MISMATCH", () => {
    const fx = restorationFixture("HEAL-SPAN-001");
    const { request, reader } = decodeFx(fx);

    const genuine = restoreSources(request, reader);
    assert.equal(genuine.mode, "A");
    assert.equal(genuine.restored.length, 1);

    const original = reader.exactShards[0]!;
    const swapped: ExactShardV1 = { ...original, originalBytes: enc("SWAPPED-AFTER-LOOKUP") };
    const result = restoreSources(request, { ...reader, exactShards: [swapped] });

    assert.ok(
      result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"),
      "digest mismatch reported",
    );
    assert.equal(result.restored.length, 0, "nothing inserted");
    assert.equal(result.mode, "C");
    assert.equal(result.semanticLossStated, true);
    assert.deepEqual(insertable(result, request), [], "insertion gate is closed");
  });

  test("a ledger record swapped after its digest check is still rejected at span level", () => {
    const fx = restorationFixture("HEAL-021");
    const { request, reader } = decodeFx(fx);
    const original = reader.ledgerEvents[0]!;
    const swappedBytes = enc("different-content");
    const swapped: EventV2 = {
      ...original,
      originalBytes: swappedBytes,
      bytesDigest: `sha256:${hex(swappedBytes)}`,
    };
    const result = restoreSources(request, { ...reader, ledgerEvents: [swapped] });
    assert.ok(result.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"));
    assert.equal(result.restored.length, 0, "nothing inserted");
  });
});
