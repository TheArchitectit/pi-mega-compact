// VC7B provider cache-economics fixtures
// (`conformance/vector-cortex/v2/cache-economics/`).
//
// Owner VC7B (computeEconomics / validateEconomics / compileCrystalBoundaries /
// assignExperiment). The acceptance test feeds these verbatim into the REAL
// production modules (src/vector-cortex/provider/{economics,experiments}.js and
// src/vector-cortex/cache/compiler.js), no mocks.
//
// `input.scenario` selects which real entry point the acceptance test drives:
//   "economics"  — computeEconomics(econ, usage, evidence), asserting the exact
//                  netSavings / tokenSavings / breakEvenHits, or the failure code.
//   "exclusion"  — validateEconomics(econ, exclusions), asserting a profile that
//                  declares exclusions without a proving fixture is REJECTED.
//   "compile"    — compileCrystalBoundaries(ranges, limits), asserting the
//                  boundary count, which segments are cacheable, and — always —
//                  that request identity is preserved.
//   "experiment" — assignExperiment(...), asserting the stable arm/bucket and
//                  causal admissibility.
//
// MONEY IS INTEGER MICRO-UNITS. Every price below is an integer (1e-6 currency
// units per token), so the golden savings figures are exact rather than
// float-rounded — a cost corpus that disagreed with the provider's bill in the
// 12th decimal place would be worse than no corpus.
//
// GOLDEN SAVINGS ARE COMPUTED HERE, NOT TYPED. `netOf()` below recomputes the
// baseline/actual arithmetic independently of the production module, so a fixture
// asserting a wrong number would have to be wrong in the same way twice.
//
// DIGESTS ARE COMPUTED, NEVER HAND-WRITTEN — every span digest is a real SHA-256
// over that range's own notional content.
//
// CACHE-001..015 are the registered VC7B economics rows and PRO-024..030 the
// provider-economics rows (continuing VC7A's PRO-016..023). The three NAMED rows
// pin the sprint's headline assertions: known prices yield golden net savings
// (CACHE-COST-001), an exclusion without a fixture ID rejects (CACHE-EXCLUDE-002),
// and every event in one session shares its arm (CACHE-RANDOM-003).

import { createHash } from "node:crypto";

import { producer } from "./common.mjs";

const ECON_SCHEMA = "schemas/cache-economics-fixture.schema.json";

/** `sha256:<hex>` over the given text — the DagSpan digest convention. */
const spanDigest = (text) =>
  `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;

/** One covered range whose pinned digest is a real hash of its content. */
const span = (sessionId, startSeq, endSeq, startByte, endByte, text) => ({
  sessionId,
  startSeq,
  endSeq,
  startByte,
  endByte,
  digest: spanDigest(text),
});

/**
 * A provider economics profile. Defaults model a realistic cache: a write costs
 * a 25% premium over the uncached price and a read costs 10% of it.
 */
const econ = (extra = {}) => ({
  schema: "provider-economics-v1",
  profileId: "anthropic-claude-opus",
  profileVersion: "v1",
  basePrice: 1000,
  readPrice: 100,
  writePrice: 1250,
  ttlMs: 300_000,
  minPrefix: 1024,
  exclusionFixtureId: null,
  ...extra,
});

/**
 * Independent recomputation of the net-savings model, used to GENERATE the
 * golden figures rather than transcribe them.
 */
const netOf = (e, cachedTokens, writeCount, hitCount) => {
  const baselineCost = cachedTokens * e.basePrice * (writeCount + hitCount);
  const actualCost = cachedTokens * (e.writePrice * writeCount + e.readPrice * hitCount);
  return {
    baselineCost,
    actualCost,
    netSavings: baselineCost - actualCost,
    tokenSavings: cachedTokens * hitCount,
  };
};

const usage = (cachedTokens, writeCount, hitCount) => ({ cachedTokens, writeCount, hitCount });

function fixture(id, assertion, input, expected) {
  return { id, schema: ECON_SCHEMA, producer, assertion, kind: "cache-economics", input, expected };
}

/** An economics row whose expected savings are computed, not typed. */
const econRow = (id, assertion, mode, e, u, evidence, extra = {}) =>
  fixture(
    id,
    assertion,
    { scenario: "economics", mode, economics: e, usage: u, evidence },
    { ok: true, ...netOf(e, u.cachedTokens, u.writeCount, u.hitCount), evidence, ...extra },
  );

const econFailRow = (id, assertion, mode, e, u, code) =>
  fixture(
    id,
    assertion,
    { scenario: "economics", mode, economics: e, usage: u, evidence: "estimate" },
    { ok: false, code },
  );

const exclusionRow = (id, assertion, mode, e, exclusions, expected) =>
  fixture(id, assertion, { scenario: "exclusion", mode, economics: e, exclusions }, expected);

const compileRow = (id, assertion, mode, ranges, limits, expected) =>
  fixture(id, assertion, { scenario: "compile", mode, ranges, limits }, expected);

const experimentRow = (id, assertion, mode, experiment, expected) =>
  fixture(id, assertion, { scenario: "experiment", mode, experiment }, expected);

/** Compiler limits: 4 bytes/token, so a 1024-token prefix is 4096 bytes. */
const LIMITS = { minPrefix: 1024, maxSegments: 64, bytesPerToken: 4 };
/** A small-prefix profile for rows that exercise merge-forward behavior. */
const SMALL_LIMITS = { minPrefix: 16, maxSegments: 64, bytesPerToken: 4 };

/** Two ranges of 4096 bytes each = 1024 tokens each: independently cacheable. */
const BIG_SPANS = [
  span("s-alpha", 1, 2, 0, 4096, "alpha-big-one"),
  span("s-alpha", 3, 4, 4096, 8192, "alpha-big-two"),
];

/** Four 32-byte ranges = 8 tokens each: individually below any real minPrefix. */
const TINY_SPANS = [
  span("s-alpha", 1, 1, 0, 32, "tiny-one"),
  span("s-alpha", 2, 2, 32, 64, "tiny-two"),
  span("s-alpha", 3, 3, 64, 96, "tiny-three"),
  span("s-alpha", 4, 4, 96, 128, "tiny-four"),
];

const experiment = (extra = {}) => ({
  experimentId: "vc7b-cache-compiler",
  sessionId: "s-alpha",
  assignedAt: 1_700_000_000_000,
  ...extra,
});

export const fixtures = [
  // ── Net savings arithmetic (CACHE-001..005) ────────────────────────────────
  econRow(
    "CACHE-001",
    "one write and four reads of a cached prefix yields a positive net saving",
    "profitable",
    econ(),
    usage(1024, 1, 4),
    "measured",
    { breakEvenHits: 1 },
  ),
  econRow(
    "CACHE-002",
    "a prefix written once and never re-read LOSES money (negative net savings, not clamped)",
    "write-only",
    econ(),
    usage(1024, 1, 0),
    "measured",
    { breakEvenHits: 1 },
  ),
  econRow(
    "CACHE-003",
    "zero traffic yields a zero baseline and a finite zero ratio (never NaN)",
    "empty",
    econ(),
    usage(0, 0, 0),
    "estimate",
    { savingsRatio: 0, breakEvenHits: 1 },
  ),
  econRow(
    "CACHE-004",
    "a shadow computation is labeled estimate and is not causal evidence",
    "shadow",
    econ(),
    usage(2048, 1, 10),
    "estimate",
    { breakEvenHits: 1 },
  ),
  econRow(
    "CACHE-005",
    "a free cache write (writePrice <= basePrice) breaks even at zero hits",
    "free-write",
    econ({ writePrice: 1000 }),
    usage(1024, 1, 1),
    "measured",
    { breakEvenHits: 0 },
  ),

  // ── Pricing / usage rejection (CACHE-006..009) ─────────────────────────────
  econFailRow(
    "CACHE-006",
    "a negative price is rejected rather than silently producing negative cost",
    "bad-price",
    econ({ readPrice: -1 }),
    usage(1024, 1, 1),
    "ECON_PRICE_INVALID",
  ),
  econFailRow(
    "CACHE-007",
    "a fractional price is rejected: money is exact integer micro-units",
    "fractional-price",
    econ({ writePrice: 1250.5 }),
    usage(1024, 1, 1),
    "ECON_PRICE_INVALID",
  ),
  econFailRow(
    "CACHE-008",
    "a negative hit count is rejected",
    "bad-usage",
    econ(),
    usage(1024, 1, -3),
    "ECON_USAGE_INVALID",
  ),
  econFailRow(
    "CACHE-009",
    "a fractional token count is rejected",
    "fractional-usage",
    econ(),
    usage(1024.5, 1, 1),
    "ECON_USAGE_INVALID",
  ),

  // ── Crystal compiler boundaries (CACHE-010..013) ───────────────────────────
  compileRow(
    "CACHE-010",
    "two full-size ranges compile to two independently cacheable boundaries",
    "two-cacheable",
    BIG_SPANS,
    LIMITS,
    { ok: true, boundaryCount: 2, cacheableCount: 2, identityPreserved: true },
  ),
  compileRow(
    "CACHE-011",
    "undersized ranges merge FORWARD until the minimum prefix is met",
    "merge-forward",
    TINY_SPANS,
    SMALL_LIMITS,
    { ok: true, boundaryCount: 2, cacheableCount: 2, identityPreserved: true },
  ),
  compileRow(
    "CACHE-012",
    "a trailing run that can never reach the minimum prefix is emitted as non-cacheable, never dropped",
    "trailing-uncacheable",
    TINY_SPANS,
    LIMITS,
    { ok: true, boundaryCount: 1, cacheableCount: 0, identityPreserved: true },
  ),
  compileRow(
    "CACHE-013",
    "a boundary never spans sessions: cross-session ranges compile separately",
    "cross-session",
    [span("s-alpha", 1, 1, 0, 4096, "cs-alpha"), span("s-beta", 1, 1, 0, 4096, "cs-beta")],
    LIMITS,
    { ok: true, boundaryCount: 2, cacheableCount: 2, identityPreserved: true },
  ),

  // ── Experiment assignment (CACHE-014..015) ─────────────────────────────────
  experimentRow(
    "CACHE-014",
    "a randomized assignment is stable and causally admissible",
    "randomized",
    experiment(),
    { ok: true, source: "randomized", causal: true, stable: true },
  ),
  experimentRow(
    "CACHE-015",
    "a forced arm is self-selected: reported, but excluded from causal intervals",
    "forced",
    experiment({ forced: "B" }),
    { ok: true, arm: "B", source: "forced", causal: false, stable: true },
  ),

  // ── Provider economics rows (PRO-024..030) ─────────────────────────────────
  exclusionRow(
    "PRO-024",
    "a profile with no exclusions needs no proving fixture",
    "no-exclusions",
    econ(),
    [],
    { ok: true },
  ),
  exclusionRow(
    "PRO-025",
    "a profile whose exclusions are backed by a fixture ID validates",
    "proven-exclusion",
    econ({ exclusionFixtureId: "PRO-EXCLUDE-010" }),
    [{ pointer: "/requestId", fixtureId: "PRO-EXCLUDE-010", proofDigest: spanDigest("proof") }],
    { ok: true },
  ),
  exclusionRow(
    "PRO-026",
    "a profile declaring exclusions with a NULL fixture ID is rejected",
    "unproven-null",
    econ({ exclusionFixtureId: null }),
    [{ pointer: "/requestId", fixtureId: "PRO-EXCLUDE-010", proofDigest: spanDigest("proof") }],
    { ok: false, code: "ECON_EXCLUSION_UNPROVEN" },
  ),
  exclusionRow(
    "PRO-027",
    "a per-exclusion blank fixture ID is rejected even when the profile names one",
    "unproven-blank-member",
    econ({ exclusionFixtureId: "PRO-EXCLUDE-010" }),
    [{ pointer: "/requestId", fixtureId: "   ", proofDigest: spanDigest("proof") }],
    { ok: false, code: "ECON_EXCLUSION_UNPROVEN" },
  ),
  econRow(
    "PRO-028",
    "a cheap-read profile repays its write premium after a single hit",
    "cheap-read",
    econ({ readPrice: 0 }),
    usage(4096, 1, 1),
    "measured",
    { breakEvenHits: 1 },
  ),
  fixture(
    "PRO-029",
    "a prefix shorter than the profile minimum is not cache-eligible at all",
    {
      scenario: "eligibility",
      mode: "below-min-prefix",
      economics: econ(),
      prefixTokens: 512,
      ageMs: 1000,
    },
    { ok: true, eligible: false },
  ),
  fixture(
    "PRO-030",
    "a prefix older than the profile TTL is not cache-eligible even when long enough",
    {
      scenario: "eligibility",
      mode: "expired-ttl",
      economics: econ(),
      prefixTokens: 4096,
      ageMs: 300_001,
    },
    { ok: true, eligible: false },
  ),
];

export const named = [
  fixture(
    "CACHE-COST-001",
    "known write/read prices yield golden net savings (named headline)",
    {
      scenario: "economics",
      mode: "golden",
      // 1000 base / 1250 write / 100 read micro-units per token, 1024-token
      // prefix, one write and four hits. baseline = 1024*1000*5 = 5_120_000;
      // actual = 1024*(1250*1 + 100*4) = 1_689_600; net = 3_430_400.
      economics: econ(),
      usage: usage(1024, 1, 4),
      evidence: "measured",
    },
    {
      ok: true,
      ...netOf(econ(), 1024, 1, 4),
      breakEvenHits: 1,
      evidence: "measured",
    },
  ),
  fixture(
    "CACHE-EXCLUDE-002",
    "provider exclusion without fixture ID rejects (named headline)",
    {
      scenario: "exclusion",
      mode: "unproven",
      // The profile claims a request field cannot affect cache identity but
      // names NO fixture proving it. An unproven exclusion is how a renderer
      // folds a field the provider actually keys on and one conversation is
      // served another's cached prefix — so it fails closed.
      economics: econ({ exclusionFixtureId: null }),
      exclusions: [
        { pointer: "/metadata/userId", fixtureId: "", proofDigest: spanDigest("unproven") },
      ],
    },
    { ok: false, code: "ECON_EXCLUSION_UNPROVEN" },
  ),
  fixture(
    "CACHE-RANDOM-003",
    "every event in one session shares one assignment, and a lost journal restores it (named headline)",
    {
      scenario: "experiment",
      mode: "session-stable",
      experiment: experiment(),
      // The acceptance test assigns repeatedly, simulating a journal loss and
      // restart between calls. The arm is a pure hash of (experimentId,
      // sessionId), so nothing is recovered — the same arm is RE-DERIVED.
      repeatAssignments: 5,
      loseJournalAfterFirst: true,
    },
    { ok: true, source: "randomized", causal: true, stable: true },
  ),
];
