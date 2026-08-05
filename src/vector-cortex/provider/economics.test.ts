/**
 * provider/economics.test.ts — VC7B cache-economics arithmetic.
 *
 * No mocks: every test feeds real `ProviderEconomicsV1` / `CacheUsageV1` into the
 * pure functions in `./economics.ts`. Golden numbers are checked against the
 * conformance fixtures (CACHE-001..015, PRO-024..030, named rows) so the unit
 * math and the corpus cannot drift apart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type CacheUsageV1,
  type EconomicsEvidence,
  type ProviderEconomicsV1,
  CACHE_IDS,
  ECONOMICS_NAMED_IDS,
  ECONOMICS_PROVIDER_IDS,
  breakEvenHits,
  computeEconomics,
  isCacheEligible,
  validateEconomics,
  validateProfileEconomics,
} from "./economics.js";
import type { ProviderProfileV1 } from "./types.js";
import { economicsFixture } from "../cache/_economics-fixture.js";

const NAMED = [...CACHE_IDS, ...ECONOMICS_PROVIDER_IDS, ...ECONOMICS_NAMED_IDS];

function econ(over: Partial<ProviderEconomicsV1> = {}): ProviderEconomicsV1 {
  return {
    schema: "provider-economics-v1",
    profileId: "test-profile",
    profileVersion: "1",
    basePrice: 1000,
    readPrice: 100,
    writePrice: 1250,
    ttlMs: 300_000,
    minPrefix: 1024,
    exclusionFixtureId: null,
    ...over,
  };
}

function usage(over: Partial<CacheUsageV1> = {}): CacheUsageV1 {
  return { cachedTokens: 1000, writeCount: 1, hitCount: 1, ...over };
}

test("registered conformance ID ranges are contiguous", () => {
  assert.equal(CACHE_IDS.length, 15);
  assert.equal(CACHE_IDS[0], "CACHE-001");
  assert.equal(CACHE_IDS[14], "CACHE-015");
  assert.equal(ECONOMICS_PROVIDER_IDS.length, 7);
  assert.equal(ECONOMICS_PROVIDER_IDS[0], "PRO-024");
  assert.deepEqual([...ECONOMICS_NAMED_IDS], ["CACHE-COST-001", "CACHE-EXCLUDE-002", "CACHE-RANDOM-003"]);
});

test("baseline minus actual yields positive net savings when reads dominate", () => {
  const r = computeEconomics(econ(), usage({ writeCount: 1, hitCount: 10 }), "measured");
  assert.ok(r.ok);
  if (!r.ok) return;
  // baseline = 1000 * 1000 * 11 = 11_000_000
  // actual   = 1000 * (1250*1 + 100*10) = 1000 * 2250 = 2_250_000
  // net      = 8_750_000
  assert.equal(r.result.baselineCost, 11_000_000);
  assert.equal(r.result.actualCost, 2_250_000);
  assert.equal(r.result.netSavings, 8_750_000);
  assert.equal(r.result.tokenSavings, 10_000);
  assert.equal(r.result.evidence, "measured");
});

test("a single write with no hits is a net LOSS and is not clamped", () => {
  const r = computeEconomics(econ(), usage({ writeCount: 1, hitCount: 0 }), "measured");
  assert.ok(r.ok);
  if (!r.ok) return;
  // baseline = 1000 * 1000 * 1 = 1_000_000
  // actual   = 1000 * (1250*1) = 1_250_000
  // net      = -250_000
  assert.equal(r.result.netSavings, -250_000);
  assert.ok(r.result.netSavings < 0);
});

test("savingsRatio is zero when baseline is zero and finite otherwise", () => {
  const zero = computeEconomics(econ(), usage({ cachedTokens: 0, writeCount: 1, hitCount: 1 }), "estimate");
  assert.ok(zero.ok);
  if (!zero.ok) return;
  assert.equal(zero.result.savingsRatio, 0);
  const pos = computeEconomics(econ(), usage({ writeCount: 1, hitCount: 2 }), "estimate");
  assert.ok(pos.ok);
  if (!pos.ok) return;
  assert.ok(Number.isFinite(pos.result.savingsRatio));
});

test("breakEvenHits: premium/discount, null when never profitable, 0 when free", () => {
  // premium 250, discount 900 -> ceil(250/900) = 1
  assert.equal(breakEvenHits(econ()), 1);
  // write cheaper than base -> 0
  assert.equal(breakEvenHits(econ({ writePrice: 800 })), 0);
  // read costs >= base -> never profitable -> null
  assert.equal(breakEvenHits(econ({ readPrice: 1000 })), null);
  assert.equal(breakEvenHits(econ({ readPrice: 1200 })), null);
});

test("validateEconomics rejects invalid prices", () => {
  const badPrice = validateEconomics(econ({ basePrice: -1 }), []);
  assert.deepEqual([...badPrice], ["ECON_PRICE_INVALID"]);
  const badTtl = validateEconomics(econ({ ttlMs: 1.5 }), []);
  assert.deepEqual([...badTtl], ["ECON_PRICE_INVALID"]);
});

test("exclusions without a proving fixture are rejected", () => {
  const ex = [{ pointer: "/foo", fixtureId: "PRO-024", proofDigest: "sha256:abc" }];
  // profile has exclusions but no exclusionFixtureId
  const missing = validateEconomics(econ({ exclusionFixtureId: null }), ex as never);
  assert.deepEqual([...missing], ["ECON_EXCLUSION_UNPROVEN"]);
});

test("blank individual exclusion fixtureId is rejected", () => {
  const ex = [{ pointer: "/foo", fixtureId: "", proofDigest: "sha256:abc" }];
  const blank = validateEconomics(econ({ exclusionFixtureId: "PRO-024" }), ex as never);
  assert.deepEqual([...blank], ["ECON_EXCLUSION_UNPROVEN"]);
});

test("validateProfileEconomics reads exclusions from the profile", () => {
  const profile = {
    profileId: "p",
    profileVersion: "1",
    exclusionFixtureId: null,
    excludedJsonPointers: [{ pointer: "/foo", fixtureId: "", proofDigest: "sha256:abc" }],
  } as unknown as ProviderProfileV1;
  const out = validateProfileEconomics(profile, econ());
  assert.deepEqual([...out], ["ECON_EXCLUSION_UNPROVEN"]);
});

test("isCacheEligible enforces minPrefix and TTL", () => {
  assert.equal(isCacheEligible(econ(), 2000, 1000), true);
  assert.equal(isCacheEligible(econ(), 500, 1000), false);
  assert.equal(isCacheEligible(econ(), 2000, 400_000), false);
  assert.equal(isCacheEligible(econ(), -1, 1000), false);
});

test("every registered fixture returns its manifest expected verdict", () => {
  for (const id of NAMED) {
    const fx = economicsFixture(id);
    const e = fx.expected;
    if (fx.input.scenario === "economics") {
      const r = computeEconomics(
        fx.input.economics as ProviderEconomicsV1,
        fx.input.usage as CacheUsageV1,
        (fx.input.mode as EconomicsEvidence) ?? "measured",
      );
      if (e.ok) {
        assert.ok(r.ok, `${id} expected ok`);
        if (r.ok && typeof e.netSavings === "number") {
          assert.equal(r.result.netSavings, e.netSavings, `${id} netSavings`);
        }
      } else {
        assert.equal(r.ok, false, `${id} expected failure ${e.code}`);
      }
    }
  }
});
