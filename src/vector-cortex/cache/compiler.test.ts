/**
 * cache/compiler.test.ts — VC7B crystal-boundary compiler.
 *
 * The compiler turns validated ranges into provider-safe cache segments. Its one
 * non-negotiable property is that it NEVER changes request identity: flattening
 * the compiled boundaries back out must equal the canonical input, ranges, order,
 * and pinned digests included. These tests pin that plus the merge-forward and
 * token-estimate behavior. No mocks — real `DagSpan`s flow through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DagSpan } from "./types.js";
import {
  boundariesPreserveIdentity,
  compileCrystalBoundaries,
  compileForKey,
  tokensForBytes,
} from "./compiler.js";
import { computeCoveredDigest } from "./crystal.js";
import { economicsFixture } from "./_economics-fixture.js";

let seq = 0;
function span(sessionId: string, startByte: number, endByte: number, digest?: string): DagSpan {
  const d = digest ?? `sha256:${sessionId}-${startByte}-${endByte}`;
  return {
    sessionId,
    startSeq: BigInt(seq),
    endSeq: BigInt(seq + 1),
    startByte,
    endByte,
    digest: d as DagSpan["digest"],
  };
}

test("tokensForBytes floors and fails safe", () => {
  assert.equal(tokensForBytes(4096, 4), 1024);
  assert.equal(tokensForBytes(4095, 4), 1023);
  assert.equal(tokensForBytes(0, 4), 0);
});

test("compiles a single cacheable segment", () => {
  const ranges = [span("s1", 0, 8192)]; // 8192/4 = 2048 tokens >= 1024 minPrefix
  const r = compileCrystalBoundaries(ranges);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.boundaries.length, 1);
  assert.equal(r.boundaries[0]!.cacheable, true);
  assert.equal(r.cacheableCount, 1);
  assert.equal(r.boundaries[0]!.tokenCount, 2048);
});

test("undersized trailing run is emitted as non-cacheable (not dropped)", () => {
  const ranges = [span("s1", 0, 4096)]; // 1024 tokens exactly == minPrefix -> cacheable
  const r = compileCrystalBoundaries(ranges);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.boundaries[0]!.tokenCount, 1024);
  assert.equal(r.boundaries[0]!.cacheable, true);

  const small = [span("s1", 0, 1000)]; // 250 tokens < 1024
  const r2 = compileCrystalBoundaries(small);
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.boundaries[0]!.cacheable, false);
});

test("merge-forward groups same-session undersized runs until cacheable", () => {
  // two 512-token runs in one session merge to 1024 -> one cacheable boundary
  const ranges = [span("s1", 0, 2048), span("s1", 2048, 4096)];
  const r = compileCrystalBoundaries(ranges);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.boundaries.length, 1);
  assert.equal(r.boundaries[0]!.sessionId, "s1");
  assert.equal(r.boundaries[0]!.cacheable, true);
});

test("a session change closes the run (boundaries never span sessions)", () => {
  const ranges = [span("s1", 0, 8192), span("s2", 0, 8192)];
  const r = compileCrystalBoundaries(ranges);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.boundaries.length, 2);
  assert.equal(r.boundaries[0]!.sessionId, "s1");
  assert.equal(r.boundaries[1]!.sessionId, "s2");
});

test("identity is preserved exactly (ranges, order, digests)", () => {
  const ranges = [span("s1", 0, 2048), span("s1", 2048, 8192), span("s2", 0, 4096)];
  const r = compileCrystalBoundaries(ranges);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(boundariesPreserveIdentity(ranges, r.boundaries), true);
});

test("compileForKey returns the SAME key object (no re-keying)", () => {
  const key = {
    schema: "crystal-key-v1" as const,
    profileId: "p",
    profileVersion: "1",
    requestDigest: "abc123",
    rendererVersion: "1",
    dependencyHighWater: 0n,
    sourceRanges: [span("s1", 0, 8192)],
    coveredDigest: computeCoveredDigest([span("s1", 0, 8192)]),
  };
  const out = compileForKey(key);
  assert.equal(out.key, key);
  assert.ok(out.compiled.ok);
});

test("rejects invalid limits", () => {
  const ranges = [span("s1", 0, 8192)];
  const bad = compileCrystalBoundaries(ranges, { minPrefix: -1, maxSegments: 64, bytesPerToken: 4 });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.deepEqual([...bad.codes], ["COMP_LIMIT_INVALID"]);
});

test("rejects invalid ranges", () => {
  // overlapping / empty ranges fail VC7A validation the compiler reuses
  const bad = compileCrystalBoundaries([]);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.deepEqual([...bad.codes], ["COMP_RANGE_INVALID"]);
});

test("compiled boundaries reproduce conformance fixture identity", () => {
  const id = "CACHE-010";
  const fx = economicsFixture(id);
  const ranges = (fx.input.ranges ?? []).map((r) => span(r.sessionId, r.startByte, r.endByte, r.digest));
  const r = compileCrystalBoundaries(ranges);
  assert.ok(r.ok, `${id} should compile`);
  if (!r.ok) return;
  assert.equal(boundariesPreserveIdentity(ranges, r.boundaries), true);
});
