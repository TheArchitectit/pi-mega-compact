/**
 * cache/vc7c-conformance.test.ts — VC7C conformance fixture execution.
 *
 * Drives every registered CACHE-016..030 + M5-001..020 + named fixture through
 * the REAL production code (`classifyMiss` for CACHE, `migrateRequestHashV2` for
 * M5) and asserts the full output matches the fixture's expected projection —
 * not just the headline miss-class/code, but every evidence byte on the
 * dashboard-visible projection.
 *
 * Manifest registration is verified first, then each fixture is executed. The
 * conformance checker (`node scripts/vector-cortex-conformance.mjs --check`)
 * already verifies SHA-256 integrity; these tests verify SEMANTIC correctness
 * of the production logic against the committed corpus.
 *
 * Sibling files:
 *   - cache/diagnostics.test.ts            — unit-level classifyMiss edge cases
 *   - cache/diagnostics-delta.test.ts      — delta clamping + transience + determinism
 *   - migrations/request-hash-v2.test.ts   — unit-level M5 copy/validate/switch
 *   - cache/flag-parity-vc7c.test.ts       — MEGACOMPACT_VC7C=0 byte-identity
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyMiss } from "./diagnostics.js";
import { migrateRequestHashV2 } from "../migrations/request-hash-v2.js";
import {
  CACHE_DIAGNOSTIC_IDS,
  CACHE_DIAGNOSTIC_NAMED_IDS,
} from "./diagnostics-types.js";
import {
  M5_IDS,
  M5_NAMED_IDS,
} from "../migrations/request-hash-v2-types.js";
import {
  cacheFx,
  m5Fx,
  toObservation,
  toM5Host,
} from "./_diagnostics-fixture.js";
import { readManifest } from "../heal/_acceptance-fixture.js";

// ── Manifest registration ────────────────────────────────────────────────────

describe("VC7C conformance registration", () => {
  test("every CACHE id is registered in the manifest under cache-diagnostics/", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of [...CACHE_DIAGNOSTIC_IDS, ...CACHE_DIAGNOSTIC_NAMED_IDS]) {
      assert.ok(ids.has(id), `manifest row present for ${id}`);
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row!.path.startsWith("cache-diagnostics/"), `${id} under cache-diagnostics/`);
      assert.equal(row!.algorithm, "cache-diagnostic", `${id} algorithm`);
    }
  });

  test("every M5 id is registered in the manifest under cache-diagnostics/", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of [...M5_IDS, ...M5_NAMED_IDS]) {
      assert.ok(ids.has(id), `manifest row present for ${id}`);
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row!.path.startsWith("cache-diagnostics/"), `${id} under cache-diagnostics/`);
      assert.equal(row!.algorithm, "request-hash-v2", `${id} algorithm`);
    }
  });

  test("the VC7C id ranges are CACHE-016..030 and M5-001..020 plus named rows", () => {
    assert.equal(CACHE_DIAGNOSTIC_IDS.length, 15);
    assert.equal(CACHE_DIAGNOSTIC_IDS[0], "CACHE-016");
    assert.equal(CACHE_DIAGNOSTIC_IDS[14], "CACHE-030");
    assert.equal(CACHE_DIAGNOSTIC_NAMED_IDS.length, 2);
    assert.equal(M5_IDS.length, 20);
    assert.equal(M5_IDS[0], "M5-001");
    assert.equal(M5_IDS[19], "M5-020");
    assert.equal(M5_NAMED_IDS.length, 1);
  });
});

// ── CACHE-016..030 execution ──────────────────────────────────────────────────

describe("CACHE-016..030 execution", () => {
  for (const id of CACHE_DIAGNOSTIC_IDS) {
    const fx = cacheFx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const obs = toObservation(fx);
      const result = classifyMiss(obs);
      assert.equal(result.missClass, fx.expected.missClass, `${id}: missClass`);

      const ev = result.evidence;
      const exp = fx.expected.evidence;
      assert.equal(ev.profileMismatch, exp.profileMismatch, `${id}: profileMismatch`);
      assert.equal(ev.rangeMismatch, exp.rangeMismatch, `${id}: rangeMismatch`);
      assert.equal(ev.dependencyAdvanced, exp.dependencyAdvanced, `${id}: dependencyAdvanced`);
      assert.equal(ev.requestMismatch, exp.requestMismatch, `${id}: requestMismatch`);
      assert.equal(ev.generationInvalidated, exp.generationInvalidated, `${id}: generationInvalidated`);
      assert.equal(ev.requestedRangeCount, exp.requestedRangeCount, `${id}: requestedRangeCount`);
      assert.equal(ev.cachedRangeCount, exp.cachedRangeCount, `${id}: cachedRangeCount`);
      assert.equal(ev.dependencyDelta, exp.dependencyDelta, `${id}: dependencyDelta`);
      assert.equal(ev.absent, exp.absent, `${id}: absent`);
    });
  }
});

// ── Named headline rows ──────────────────────────────────────────────────────

describe("VC7C named headline rows", () => {
  for (const id of CACHE_DIAGNOSTIC_NAMED_IDS) {
    const fx = cacheFx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const obs = toObservation(fx);
      const result = classifyMiss(obs);
      assert.equal(result.missClass, fx.expected.missClass, `${id}: missClass`);
      assert.equal(result.schema, "cache-diagnostic-v1", `${id}: schema`);

      const ev = result.evidence;
      const exp = fx.expected.evidence;
      assert.equal(ev.absent, exp.absent, `${id}: absent`);
      assert.equal(ev.profileMismatch, exp.profileMismatch, `${id}: profileMismatch`);
    });
  }
});

// ── M5-001..020 execution ─────────────────────────────────────────────────────

describe("M5-001..020 execution", () => {
  for (const id of M5_IDS) {
    const fx = m5Fx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const host = toM5Host(fx);
      const result = migrateRequestHashV2(host);
      assert.equal(result.ok, fx.expected.ok, `${id}: ok`);
      assert.deepEqual(
        [...result.codes].sort(),
        [...fx.expected.codes].sort(),
        `${id}: codes`,
      );
      assert.equal(
        host.activeVersionAfter,
        fx.expected.activeVersionAfter,
        `${id}: activeVersionAfter`,
      );
    });
  }
});

// ── M5-COLLIDE-002 named headline ────────────────────────────────────────────

describe("M5 named headline rows", () => {
  for (const id of M5_NAMED_IDS) {
    const fx = m5Fx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const host = toM5Host(fx);
      const result = migrateRequestHashV2(host);
      assert.equal(result.ok, fx.expected.ok, `${id}: ok`);
      assert.deepEqual(
        [...result.codes].sort(),
        [...fx.expected.codes].sort(),
        `${id}: codes`,
      );
      assert.equal(
        host.activeVersionAfter,
        fx.expected.activeVersionAfter,
        `${id}: activeVersionAfter=${fx.expected.activeVersionAfter}`,
      );
    });
  }
});
