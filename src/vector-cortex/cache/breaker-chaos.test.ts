/**
 * cache/breaker-chaos.test.ts — VC7C cache-serve breaker decision + triad recovery.
 *
 * Exercises the cache breaker from `./breaker.ts`, which COMPOSES VC0C's
 * createBreaker (no parallel state machine). The decision under test is the one
 * the sprint contract pins: demote before cache serve on profile mismatch, range
 * (digest) mismatch, advanced dependency, or invalidated generation — and NEVER
 * on an `unknown` miss. The forced fallback mode honors the triad's own verdict
 * (an already-escalated OPEN_C / MANUAL_HALT wins over B).
 *
 * No mocks of the triad; the REAL createBreaker is used. PREVENT-011 honored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Mode } from "../resilience/types.js";
import {
  CACHE_SUBSYSTEM,
  createCacheBreaker,
  decideCacheServe,
  shouldBlockServe,
  tripKindForMiss,
} from "./breaker.js";
import type { MissClass } from "./diagnostics-types.js";

const classes: MissClass[] = [
  "profile",
  "range",
  "dependency",
  "request",
  "generation",
  "unknown",
];

test("VC7C breaker: every real miss blocks the cache serve; unknown does not", () => {
  for (const c of classes) {
    assert.equal(shouldBlockServe(c), c !== "unknown", `${c} block expectation`);
  }
});

test("VC7C breaker: a blockable miss demotes to a fresh render (mode B) by default", () => {
  const b = createCacheBreaker();
  for (const c of ["profile", "range", "dependency", "request", "generation"] as MissClass[]) {
    const d = decideCacheServe(c, b);
    assert.equal(d.block, true);
    assert.equal(d.fallbackMode, "B", `${c} -> fresh render`);
  }
});

test("VC7C breaker: an unknown miss does not block and lets the triad run mode A when healthy", () => {
  const b = createCacheBreaker();
  const d = decideCacheServe("unknown", b);
  assert.equal(d.block, false);
  // The triad is healthy (CLOSED_A), so modeFor is A and the serve proceeds.
  assert.equal(b.modeFor(CACHE_SUBSYSTEM), "A");
  assert.equal(d.fallbackMode, "A");
});

test("VC7C breaker: a deeper open state is honored — already at C wins over B", () => {
  const b = createCacheBreaker();
  // Register the subsystem first so manualHalt can find it in the targets.
  b.snapshot(CACHE_SUBSYSTEM);
  // Force the breaker into MANUAL_HALT (simulate an authority outage).
  b.manualHalt("chaos-test");
  const d = decideCacheServe("profile", b);
  assert.equal(d.block, true);
  assert.equal(d.fallbackMode, "C", "manual halt (C) must not be downgraded to B");
});

test("VC7C breaker: each of the four named conditions independently blocks", () => {
  const b = createCacheBreaker();
  const conditions: MissClass[] = ["profile", "range", "dependency", "generation"];
  for (const c of conditions) {
    const d = decideCacheServe(c, b);
    assert.equal(d.block, true, `${c} must block before cache serve`);
    assert.equal(d.fallbackMode, "B");
  }
});

test("VC7C breaker: compose check — the breaker is the VC0C breaker, same subsystem contract", () => {
  const b = createCacheBreaker();
  assert.equal(typeof b.modeFor, "function");
  assert.equal(typeof b.snapshot, "function");
  assert.equal(CACHE_SUBSYSTEM, "vector-cortex-cache-serve");
  // Reset must be idempotent and non-fatal.
  assert.doesNotThrow(() => b.reset(CACHE_SUBSYSTEM));
  assert.equal(b.modeFor(CACHE_SUBSYSTEM), "A" as Mode);
});

test("VC7C breaker: trip kind mapping — profile/range/request are correctness, dependency/generation are performance", () => {
  assert.equal(tripKindForMiss("profile"), "correctness");
  assert.equal(tripKindForMiss("range"), "correctness");
  assert.equal(tripKindForMiss("request"), "correctness");
  assert.equal(tripKindForMiss("dependency"), "performance");
  assert.equal(tripKindForMiss("generation"), "performance");
  assert.equal(tripKindForMiss("unknown"), "performance");
});

test("VC7C breaker: decideCacheServe returns the trip kind alongside the decision", () => {
  const b = createCacheBreaker();
  const d = decideCacheServe("profile", b);
  assert.equal(d.tripKind, "correctness");
  const d2 = decideCacheServe("dependency", b);
  assert.equal(d2.tripKind, "performance");
});
