/**
 * cache/diagnostics-delta.test.ts — VC7C delta clamping, transience, determinism.
 *
 * Extracted from diagnostics.test.ts to keep both files under the 300-line
 * src/ soft-as-hard limit. Same helpers, same imports — delta clamping
 * (advanceDelta), transient-miss classification (isTransientMiss), and the
 * determinism/totality pin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyMiss,
  collectEvidence,
  isTransientMiss,
} from "./diagnostics.js";
import type { MissObservation } from "./diagnostics-types.js";

/** Digest conventions: covered is `sha256:`-prefixed, request is BARE hex. */
const COVERED_A = "sha256:aaaa";
const COVERED_B = "sha256:bbbb";
const REQ_A = "1111";
const REQ_B = "2222";

/** Baseline observation that would HIT; overrides isolate the tested mismatch. */
function obs(over: Partial<MissObservation> = {}): MissObservation {
  return {
    requestProfileId: "anthropic-claude-opus",
    requestProfileVersion: "v1",
    cachedProfileId: "anthropic-claude-opus",
    cachedProfileVersion: "v1",
    requestCoveredDigest: COVERED_A,
    cachedCoveredDigest: COVERED_A,
    requestedRangeCount: 3,
    cachedRangeCount: 3,
    requestDigest: REQ_A,
    cachedRequestDigest: REQ_A,
    requestDependencyHighWater: 100n,
    cachedDependencyHighWater: 100n,
    generationInvalidated: false,
    ...over,
  };
}

// ── advanceDelta clamping ────────────────────────────────────────────────────

test("VC7C delta: a request BEHIND the crystal is not an advance and clamps to zero", () => {
  const e = collectEvidence(
    obs({ requestDependencyHighWater: 50n, cachedDependencyHighWater: 100n }),
  );
  assert.equal(e.dependencyAdvanced, false, "reading an older validated frontier is legal");
  assert.equal(e.dependencyDelta, 0, "a negative advance would be nonsense");
});

test("VC7C delta: an equal high-water is not an advance", () => {
  const e = collectEvidence(obs({ requestDependencyHighWater: 100n }));
  assert.equal(e.dependencyAdvanced, false);
  assert.equal(e.dependencyDelta, 0);
});

test("VC7C delta: a huge advance saturates at MAX_SAFE_INTEGER rather than losing precision", () => {
  const huge = BigInt(Number.MAX_SAFE_INTEGER) * 4n;
  const e = collectEvidence(
    obs({ requestDependencyHighWater: huge, cachedDependencyHighWater: 0n }),
  );
  assert.equal(e.dependencyAdvanced, true);
  assert.equal(e.dependencyDelta, Number.MAX_SAFE_INTEGER, "saturate, never silently truncate");
  assert.ok(Number.isSafeInteger(e.dependencyDelta));
});

test("VC7C delta: a delta exactly at MAX_SAFE_INTEGER is reported exactly", () => {
  const e = collectEvidence(
    obs({
      requestDependencyHighWater: BigInt(Number.MAX_SAFE_INTEGER),
      cachedDependencyHighWater: 0n,
    }),
  );
  assert.equal(e.dependencyDelta, Number.MAX_SAFE_INTEGER);
});

// ── Transience ───────────────────────────────────────────────────────────────

test("VC7C transience: profile and generation are transient; the rest are not", () => {
  const cases: ReadonlyArray<readonly [MissObservation, boolean]> = [
    [obs({ cachedProfileId: "other" }), true],
    [obs({ generationInvalidated: true }), true],
    [obs({ cachedCoveredDigest: COVERED_B }), false],
    [obs({ requestDependencyHighWater: 200n }), false],
    [obs({ cachedRequestDigest: REQ_B }), false],
    [obs(), false],
  ];
  for (const [o, expected] of cases) {
    const d = classifyMiss(o);
    assert.equal(isTransientMiss(d), expected, `${d.missClass} transience`);
  }
});

test("VC7C transience: an unknown miss is NEVER called transient", () => {
  const d = classifyMiss(obs());
  assert.equal(d.missClass, "unknown");
  assert.equal(
    isTransientMiss(d),
    false,
    "telling an operator an unexplained miss self-heals is how an eviction bug runs for months",
  );
});

// ── Determinism / totality ───────────────────────────────────────────────────

test("VC7C diagnostics: classification is deterministic and never throws", () => {
  const o = obs({ cachedProfileId: "other", cachedCoveredDigest: COVERED_B });
  const first = classifyMiss(o);
  for (let i = 0; i < 25; i++) assert.deepEqual(classifyMiss(o), first);
});

// ── Absent-guard regression (conformance alignment) ────────────────────────

test("VC7C regression: a cold key with cachedRangeCount=0 (conformance convention) classifies unknown, not range", () => {
  // The conformance corpus uses absent() which sets cachedRangeCount: 0 (not
  // null) on a cold key. Without the !absent guard on rangeMismatch, the
  // rangeCount arm fires (0 !== 2) and classifies "range" instead of "unknown"
  // — contradicting the documented "absence is not a mismatch" contract.
  const d = classifyMiss(obs({
    cachedProfileId: null,
    cachedProfileVersion: null,
    cachedCoveredDigest: null,
    cachedRangeCount: 0,
    cachedRequestDigest: null,
    cachedDependencyHighWater: null,
    requestedRangeCount: 2,
  }));
  assert.equal(d.missClass, "unknown", "absence is not a mismatch");
  assert.equal(d.evidence.absent, true);
  assert.equal(d.evidence.rangeMismatch, false);
});

test("VC7C regression: a cold key with generation invalidation still classifies generation", () => {
  const d = classifyMiss(obs({
    cachedProfileId: null,
    cachedProfileVersion: null,
    cachedCoveredDigest: null,
    cachedRangeCount: 0,
    cachedRequestDigest: null,
    cachedDependencyHighWater: null,
    requestedRangeCount: 2,
    generationInvalidated: true,
  }));
  assert.equal(d.missClass, "generation");
  assert.equal(d.evidence.absent, true);
});
