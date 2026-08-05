/**
 * cache/diagnostics.test.ts — VC7C miss-classification unit tests.
 *
 * Drives the REAL `classifyMiss` / `collectEvidence` / `classFor` /
 * `isTransientMiss` from `./diagnostics.ts` — no mocks, no parallel test shape.
 * The observations below are ordinary `MissObservation` values built by a helper
 * that starts from a HITTING baseline (every request field equal to its cached
 * counterpart) and mutates exactly the fields under test, so a row that claims
 * to isolate one mismatch really does isolate it.
 *
 * The load-bearing assertions are the EXCLUSIVE RANKING ones: a classifier that
 * returned a set would be untestable for "which cause should an operator act
 * on", so each co-occurrence row pins the single winner AND asserts the losing
 * evidence flags are still reported.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classFor,
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

/**
 * A baseline observation that would HIT: every request field equals its cached
 * counterpart and no generation is invalidated. Each test overrides only the
 * fields whose mismatch it is isolating.
 */
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

/** A cold key: nothing was cached, so there is nothing to disagree with. */
function coldObs(over: Partial<MissObservation> = {}): MissObservation {
  return obs({
    cachedProfileId: null,
    cachedProfileVersion: null,
    cachedCoveredDigest: null,
    cachedRequestDigest: null,
    cachedDependencyHighWater: null,
    ...over,
  });
}

// ── One class per cause ──────────────────────────────────────────────────────

test("VC7C diagnostics: a differing profile id classifies as profile", () => {
  const d = classifyMiss(obs({ cachedProfileId: "anthropic-claude-sonnet" }));
  assert.equal(d.missClass, "profile");
  assert.equal(d.schema, "cache-diagnostic-v1");
  assert.equal(d.evidence.profileMismatch, true);
});

test("VC7C diagnostics: a differing profile VERSION also classifies as profile", () => {
  const d = classifyMiss(obs({ cachedProfileVersion: "v2" }));
  assert.equal(d.missClass, "profile");
  assert.equal(d.evidence.profileMismatch, true);
});

test("VC7C diagnostics: a differing covered digest classifies as range", () => {
  const d = classifyMiss(obs({ cachedCoveredDigest: COVERED_B }));
  assert.equal(d.missClass, "range");
  assert.equal(d.evidence.rangeMismatch, true);
  assert.equal(d.evidence.profileMismatch, false);
});

test("VC7C diagnostics: a differing range COUNT classifies as range", () => {
  const d = classifyMiss(obs({ cachedRangeCount: 2 }));
  assert.equal(d.missClass, "range");
  assert.equal(d.evidence.requestedRangeCount, 3);
  assert.equal(d.evidence.cachedRangeCount, 2);
});

test("VC7C diagnostics: an advanced dependency high-water classifies as dependency", () => {
  const d = classifyMiss(obs({ requestDependencyHighWater: 140n }));
  assert.equal(d.missClass, "dependency");
  assert.equal(d.evidence.dependencyAdvanced, true);
  assert.equal(d.evidence.dependencyDelta, 40);
});

test("VC7C diagnostics: a differing request digest alone classifies as request", () => {
  const d = classifyMiss(obs({ cachedRequestDigest: REQ_B }));
  assert.equal(d.missClass, "request");
  assert.equal(d.evidence.requestMismatch, true);
  assert.equal(d.evidence.dependencyAdvanced, false);
});

test("VC7C diagnostics: an invalidated generation with nothing else differing classifies as generation", () => {
  const d = classifyMiss(obs({ generationInvalidated: true }));
  assert.equal(d.missClass, "generation");
  assert.equal(d.evidence.generationInvalidated, true);
});

test("VC7C diagnostics: an unexplained miss keeps its own unknown label", () => {
  const d = classifyMiss(obs());
  assert.equal(d.missClass, "unknown");
});

// ── The exclusive ranking ────────────────────────────────────────────────────

test("VC7C ranking: profile outranks range, dependency, request and generation", () => {
  const d = classifyMiss(
    obs({
      cachedProfileId: "anthropic-claude-sonnet",
      cachedCoveredDigest: COVERED_B,
      cachedRequestDigest: REQ_B,
      requestDependencyHighWater: 200n,
      generationInvalidated: true,
    }),
  );
  assert.equal(d.missClass, "profile", "a profile bump explains every downstream difference");
});

test("VC7C ranking: range outranks dependency, request and generation", () => {
  const d = classifyMiss(
    obs({
      cachedCoveredDigest: COVERED_B,
      cachedRequestDigest: REQ_B,
      requestDependencyHighWater: 200n,
      generationInvalidated: true,
    }),
  );
  assert.equal(d.missClass, "range", "an irrelevant crystal outranks a merely stale one");
});

test("VC7C ranking: dependency outranks request and generation", () => {
  const d = classifyMiss(
    obs({
      cachedRequestDigest: REQ_B,
      requestDependencyHighWater: 200n,
      generationInvalidated: true,
    }),
  );
  assert.equal(d.missClass, "dependency");
});

test("VC7C ranking: request outranks generation", () => {
  const d = classifyMiss(obs({ cachedRequestDigest: REQ_B, generationInvalidated: true }));
  assert.equal(d.missClass, "request");
});

test("VC7C ranking: classFor is the whole contract and is total over every evidence shape", () => {
  const base = collectEvidence(obs());
  assert.equal(classFor({ ...base, profileMismatch: true }), "profile");
  assert.equal(classFor({ ...base, rangeMismatch: true }), "range");
  assert.equal(classFor({ ...base, dependencyAdvanced: true }), "dependency");
  assert.equal(classFor({ ...base, requestMismatch: true }), "request");
  assert.equal(classFor({ ...base, generationInvalidated: true }), "generation");
  assert.equal(classFor(base), "unknown");
});

// ── Absence is not a mismatch ────────────────────────────────────────────────

test("VC7C absence: a cold key classifies as unknown, never as a profile incident", () => {
  const d = classifyMiss(coldObs());
  assert.equal(d.missClass, "unknown", "null !== 'anthropic-...' must not fabricate a mismatch");
  assert.equal(d.evidence.absent, true);
  assert.equal(d.evidence.profileMismatch, false);
  assert.equal(d.evidence.rangeMismatch, false);
  assert.equal(d.evidence.dependencyAdvanced, false);
  assert.equal(d.evidence.requestMismatch, false);
});

test("VC7C absence: a cold key with an invalidated generation classifies as generation", () => {
  const d = classifyMiss(coldObs({ generationInvalidated: true }));
  assert.equal(d.missClass, "generation");
  assert.equal(d.evidence.absent, true);
});

test("VC7C absence: a cold key reports zero cached ranges and zero dependency delta", () => {
  const e = collectEvidence(coldObs({ requestedRangeCount: 7, cachedRangeCount: 99 }));
  assert.equal(e.cachedRangeCount, 0, "nothing was cached, so no cached range count is real");
  assert.equal(e.dependencyDelta, 0);
  assert.equal(e.requestedRangeCount, 7, "what the caller asked for is still observable");
});

// ── Evidence reports co-occurrence ───────────────────────────────────────────

test("VC7C evidence: a profile miss still reports the co-occurring range difference", () => {
  const d = classifyMiss(
    obs({ cachedProfileId: "anthropic-claude-sonnet", cachedCoveredDigest: COVERED_B }),
  );
  assert.equal(d.missClass, "profile");
  assert.equal(
    d.evidence.rangeMismatch,
    true,
    "the ranking picks one cause; the evidence must still show the rest",
  );
});

test("VC7C evidence: every co-occurring flag is reported alongside the winning class", () => {
  const d = classifyMiss(
    obs({
      cachedProfileId: "other",
      cachedCoveredDigest: COVERED_B,
      cachedRangeCount: 1,
      cachedRequestDigest: REQ_B,
      requestDependencyHighWater: 175n,
      generationInvalidated: true,
    }),
  );
  assert.equal(d.missClass, "profile");
  assert.deepEqual(
    {
      profileMismatch: d.evidence.profileMismatch,
      rangeMismatch: d.evidence.rangeMismatch,
      dependencyAdvanced: d.evidence.dependencyAdvanced,
      requestMismatch: d.evidence.requestMismatch,
      generationInvalidated: d.evidence.generationInvalidated,
    },
    {
      profileMismatch: true,
      rangeMismatch: true,
      dependencyAdvanced: true,
      requestMismatch: true,
      generationInvalidated: true,
    },
  );
});

test("VC7C evidence: the payload-free record carries only booleans and bounded counts", () => {
  const e = collectEvidence(obs({ cachedProfileId: "other" }));
  for (const [key, value] of Object.entries(e)) {
    assert.ok(
      typeof value === "boolean" || typeof value === "number",
      `evidence.${key} must be a boolean or a count, never a payload (got ${typeof value})`,
    );
  }
});

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
