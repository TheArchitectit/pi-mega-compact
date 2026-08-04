/**
 * heal/verify.test.ts — VC6B `verifyRestored` / `insertable` unit tests.
 *
 * The verifier's job is to fail on results that `restoreSources` would never
 * produce but that could reach an insertion site anyway (mutation in transit,
 * a hand-assembled result, a merge of two batches). So these tests mostly
 * construct results DIRECTLY rather than via the restorer — that is the threat
 * model.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type {
  RestoreRequestV1,
  RestoreResultV1,
  RestoreSpanResult,
  ShardRange,
} from "./restore-types.js";
import { verifyRestored, insertable } from "./verify.js";

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));
const hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function mkRange(seq: number): ShardRange {
  return {
    sessionId: "s1",
    seqStart: BigInt(seq),
    seqEnd: BigInt(seq),
    byteStart: 0,
    byteEnd: 8,
  };
}

function mkRequest(
  entries: ReadonlyArray<{ nodeId: string; text: string }>,
): RestoreRequestV1 {
  return {
    schema: "restore-request-v1",
    sessionId: "s1",
    spans: entries.map((e, i) => ({
      nodeId: e.nodeId,
      range: mkRange(i + 1),
      digest: hex(enc(e.text)),
    })),
  };
}

function mkResult(restored: readonly RestoreSpanResult[]): RestoreResultV1 {
  return {
    schema: "restore-result-v1",
    sessionId: "s1",
    mode: "A",
    restored,
    missing: [],
    semanticLossStated: false,
    codes: [],
  };
}

const span = (nodeId: string, text: string, digestText = text): RestoreSpanResult => ({
  nodeId,
  source: "exact-shard",
  bytes: enc(text),
  digest: hex(enc(digestText)),
});

describe("verifyRestored: valid results", () => {
  test("a result whose bytes hash to the requested digests verifies", () => {
    const request = mkRequest([
      { nodeId: "n1", text: "alpha" },
      { nodeId: "n2", text: "beta" },
    ]);
    const result = mkResult([span("n1", "alpha"), span("n2", "beta")]);
    assert.deepEqual(verifyRestored(result, request), { ok: true });
  });

  test("an empty restoration verifies vacuously", () => {
    assert.deepEqual(verifyRestored(mkResult([]), mkRequest([])), { ok: true });
  });
});

describe("verifyRestored: digest mismatch", () => {
  test("tampered bytes fail their own stated digest", () => {
    const request = mkRequest([{ nodeId: "n1", text: "alpha" }]);
    // Bytes swapped after restoration; the digest field still says "alpha".
    const tampered: RestoreSpanResult = {
      nodeId: "n1",
      source: "exact-shard",
      bytes: enc("TAMPERED"),
      digest: hex(enc("alpha")),
    };
    const v = verifyRestored(mkResult([tampered]), request);
    assert.equal(v.ok, false);
    assert.deepEqual(v.ok === false ? v.codes : [], ["HEAL_RESTORE_DIGEST_MISMATCH"]);
  });

  test("a truncated read fails verification", () => {
    const request = mkRequest([{ nodeId: "n1", text: "alphabet" }]);
    const truncated: RestoreSpanResult = {
      nodeId: "n1",
      source: "ledger-scan",
      bytes: enc("alpha"),
      digest: hex(enc("alphabet")),
    };
    const v = verifyRestored(mkResult([truncated]), request);
    assert.equal(v.ok, false);
    assert.ok(v.ok === false && v.codes.includes("HEAL_RESTORE_DIGEST_MISMATCH"));
  });
});

describe("verifyRestored: range/provenance mismatch", () => {
  test("a restored nodeId absent from the request is a range mismatch", () => {
    const request = mkRequest([{ nodeId: "n1", text: "alpha" }]);
    // Internally consistent bytes, but nobody asked for "rogue".
    const v = verifyRestored(mkResult([span("rogue", "alpha")]), request);
    assert.equal(v.ok, false);
    assert.deepEqual(v.ok === false ? v.codes : [], ["HEAL_RESTORE_RANGE_MISMATCH"]);
  });

  test("a digest disagreeing with the request's digest for that node is a range mismatch", () => {
    const request = mkRequest([{ nodeId: "n1", text: "alpha" }]);
    // "right bytes, wrong span": internally consistent, but not what n1 pinned.
    const v = verifyRestored(mkResult([span("n1", "beta")]), request);
    assert.equal(v.ok, false);
    assert.deepEqual(v.ok === false ? v.codes : [], ["HEAL_RESTORE_RANGE_MISMATCH"]);
  });

  test("codes are deduplicated in deterministic priority order", () => {
    const request = mkRequest([{ nodeId: "n1", text: "alpha" }]);
    const bad: RestoreSpanResult = {
      nodeId: "n1",
      source: "exact-shard",
      bytes: enc("x"),
      digest: hex(enc("alpha")),
    };
    const v = verifyRestored(mkResult([bad, bad, span("rogue", "alpha")]), request);
    assert.equal(v.ok, false);
    assert.deepEqual(v.ok === false ? v.codes : [], [
      "HEAL_RESTORE_DIGEST_MISMATCH",
      "HEAL_RESTORE_RANGE_MISMATCH",
    ]);
  });
});

describe("insertable: wholesale gating", () => {
  test("returns every span when the result verifies", () => {
    const request = mkRequest([{ nodeId: "n1", text: "alpha" }]);
    const result = mkResult([span("n1", "alpha")]);
    assert.equal(insertable(result, request).length, 1);
  });

  test("returns NOTHING when any span fails — never a partial insert", () => {
    const request = mkRequest([
      { nodeId: "n1", text: "alpha" },
      { nodeId: "n2", text: "beta" },
    ]);
    const bad: RestoreSpanResult = {
      nodeId: "n2",
      source: "exact-shard",
      bytes: enc("TAMPERED"),
      digest: hex(enc("beta")),
    };
    const result = mkResult([span("n1", "alpha"), bad]);
    assert.deepEqual(insertable(result, request), [], "the good span is withheld too");
  });
});
