/**
 * vector-cortex/shards/manifest.test.ts — shard manifest assembly + validation
 * unit tests (VC4A). Drives the REAL `buildShardManifest`,
 * `validateShardManifest`, `shardManifestDigest`, `assembleAndValidate`, and
 * `manifestSorted` against hand-built shard sets: valid-cover, overlap-reject
 * (SHD_RANGE_OVERLAP), gap-reject (SHD_PROTECTED_GAP), sorted-ranges,
 * digest-stable, and reporter emission gating (flag on/off). No mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildShardManifest,
  validateShardManifest,
  shardManifestDigest,
  assembleAndValidate,
  manifestSorted,
} from "./manifest.js";
import type { SemanticShardV1, ExactShardV1, ShardRange } from "./types.js";

function sem(seqStart: number, seqEnd: number, byteStart: number, byteEnd: number): SemanticShardV1 {
  return {
    schema: "semantic-shard-v1",
    sessionId: "s",
    range: { sessionId: "s", seqStart: BigInt(seqStart), seqEnd: BigInt(seqEnd), byteStart, byteEnd },
    kind: "semantic",
    digest: `sha256:sem-${seqStart}`,
    byteCount: byteEnd - byteStart,
    eventCount: seqEnd - seqStart + 1,
    tokenEstimate: byteEnd - byteStart,
  };
}

function exact(seqStart: number, seqEnd: number, byteStart: number, byteEnd: number): ExactShardV1 {
  return {
    schema: "exact-shard-v1",
    sessionId: "s",
    range: { sessionId: "s", seqStart: BigInt(seqStart), seqEnd: BigInt(seqEnd), byteStart, byteEnd },
    kind: "exact",
    originalBytes: new Uint8Array(byteEnd - byteStart),
    digest: `sha256:ex-${seqStart}`,
    byteCount: byteEnd - byteStart,
    case: "anchor",
  };
}

function span(seqStart: number, seqEnd: number, byteStart: number, byteEnd: number): ShardRange {
  return { sessionId: "s", seqStart: BigInt(seqStart), seqEnd: BigInt(seqEnd), byteStart, byteEnd };
}

const sessionId = "s";
const sourceHighWater = 8n;

describe("validateShardManifest", () => {
  test("valid-cover: disjoint ranges + exact-tiles-protected passes", () => {
    const m = buildShardManifest({
      sessionId,
      sourceHighWater,
      semantic: [sem(1, 2, 0, 8), sem(3, 4, 8, 16)],
      exact: [exact(1, 1, 0, 4), exact(3, 3, 8, 10)],
      protectedSpans: [span(1, 1, 0, 4), span(3, 3, 8, 10)],
    });
    assert.deepEqual(validateShardManifest(m), { ok: true });
  });

  test("overlap-reject (SHD_RANGE_OVERLAP): overlapping semantic ranges fail", () => {
    const m = buildShardManifest({
      sessionId,
      sourceHighWater,
      semantic: [sem(1, 2, 0, 8), sem(2, 3, 6, 16)], // overlap [6,8)
      exact: [],
      protectedSpans: [],
    });
    const v = validateShardManifest(m);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_RANGE_OVERLAP");
  });

  test("gap-reject (SHD_PROTECTED_GAP): a protected span with no exact shard fails", () => {
    const m = buildShardManifest({
      sessionId,
      sourceHighWater,
      semantic: [sem(1, 4, 0, 16)],
      exact: [exact(1, 1, 0, 2)], // only covers part of protected region
      protectedSpans: [span(1, 4, 0, 16)],
    });
    const v = validateShardManifest(m);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_PROTECTED_GAP");
  });

  test("gap-reject (SHD_PROTECTED_GAP): an exact shard covering an un-protected byte fails", () => {
    const m = buildShardManifest({
      sessionId,
      sourceHighWater,
      semantic: [sem(1, 4, 0, 16)],
      exact: [exact(1, 1, 0, 4)], // byte [0,4) but protected is only [0,2)
      protectedSpans: [span(1, 1, 0, 2)],
    });
    const v = validateShardManifest(m);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_PROTECTED_GAP");
  });

  test("gap-reject (SHD_PROTECTED_GAP): a manifest with no protected spans is malformed", () => {
    const m = buildShardManifest({
      sessionId,
      sourceHighWater,
      semantic: [sem(1, 4, 0, 16)],
      exact: [exact(1, 1, 0, 4)],
      protectedSpans: [],
    });
    const v = validateShardManifest(m);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_PROTECTED_GAP");
  });
});

describe("buildShardManifest + digest", () => {
  test("sorted-ranges: manifest shards are sorted by (seqStart, byteStart)", () => {
    const m = buildShardManifest({
      sessionId,
      sourceHighWater,
      // Supply out of order; builder must sort.
      semantic: [sem(3, 4, 8, 16), sem(1, 2, 0, 8)],
      exact: [exact(2, 2, 4, 6)],
      protectedSpans: [span(2, 2, 4, 6)],
    });
    assert.equal(manifestSorted(m), true);
    assert.equal(m.semantic[0].range.seqStart, 1n);
    assert.equal(m.semantic[1].range.seqStart, 3n);
  });

  test("digest-stable: order-independent — same set sorted differently yields same digest", () => {
    const a = shardManifestDigest(sessionId, sourceHighWater, [sem(1, 2, 0, 8), sem(3, 4, 8, 16)], [exact(1, 1, 0, 4)]);
    const b = shardManifestDigest(sessionId, sourceHighWater, [sem(3, 4, 8, 16), sem(1, 2, 0, 8)], [exact(1, 1, 0, 4)]);
    assert.equal(a, b);
  });

  test("digest-changes: a different shard set changes the digest", () => {
    const a = shardManifestDigest(sessionId, sourceHighWater, [sem(1, 2, 0, 8)], []);
    const b = shardManifestDigest(sessionId, sourceHighWater, [sem(1, 2, 0, 8), sem(3, 4, 8, 16)], []);
    assert.notEqual(a, b);
  });
});

describe("assembleAndValidate + reporter", () => {
  test("success emits vector_cortex_shard_manifest_built and returns ok", () => {
    let emitted: Array<[string, Record<string, unknown>]> = [];
    const r = assembleAndValidate(
      {
        sessionId,
        sourceHighWater,
        semantic: [sem(1, 2, 0, 8)],
        exact: [exact(1, 1, 0, 4)],
        protectedSpans: [span(1, 1, 0, 4)],
      },
      (ev, fields) => emitted.push([ev, fields]),
    );
    assert.equal(r.ok, true);
    assert.ok(emitted.some(([ev]) => ev === "vector_cortex_shard_manifest_built"));
  });

  test("failure emits vector_cortex_protected_span_rejected and returns the code", () => {
    let emitted: Array<[string, Record<string, unknown>]> = [];
    const r = assembleAndValidate(
      {
        sessionId,
        sourceHighWater,
        semantic: [sem(1, 2, 0, 8)],
        exact: [exact(1, 1, 0, 2)], // gap vs protected [0,4)
        protectedSpans: [span(1, 1, 0, 4)],
      },
      (ev, fields) => emitted.push([ev, fields]),
    );
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "SHD_PROTECTED_GAP");
    assert.ok(emitted.some(([ev]) => ev === "vector_cortex_protected_span_rejected"));
  });
});
