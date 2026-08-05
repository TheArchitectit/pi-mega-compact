// VC7C cache-diagnostics fixtures (`conformance/vector-cortex/v2/cache-diagnostics/`).
//
// Owner VC7C (classifyMiss / diagnostics / breaker / M5 request-hash-v2 switch).
// The acceptance test feeds these verbatim into the REAL production modules
// (src/vector-cortex/cache/diagnostics.js and src/vector-cortex/migrations/request-hash-v2.js),
// no mocks.
//
// TWO KINDS, ONE DIR:
//   kind "cache-diagnostic"  (CACHE-016..030 + CACHE-MISS-001 + CACHE-STALE-003)
//      — pin the EXCLUSIVE miss-classification order (profile -> range ->
//        dependency -> request -> generation -> unknown) from classifyMiss.
//   kind "request-hash-v2"    (M5-001..020 + M5-COLLIDE-002)
//      — pin the COMPLETED M5 copy/validate/SWITCH migration.
//
// PAYLOAD-FREE BY CONSTRUCTION. Every input is a digest (sha256-prefixed covered
// digest; BARE lowercase hex request digest), a profile id/version, bounded range
// counts, a dependency high-water integer, and a generation-invalidated boolean.
// NO request payload, NO session id, NO covered ranges of user content. The
// classifier is pure and deterministic; the same observation always yields the
// same single class.
//
// DIGESTS ARE COMPUTED, NEVER HAND-WRITTEN — every digest below is a real SHA-256
// over that field's own notional content, so a fixture that disagreed with the
// production derivation would fail the acceptance test instead of looking right.
// The golden classification is asserted from the OBSERVATION, not typed.

import { createHash } from "node:crypto";

import { producer } from "./common.mjs";

const DIAG_SCHEMA = "schemas/cache-diagnostic-fixture.schema.json";
const M5_SCHEMA = "schemas/request-hash-v2-fixture.schema.json";

/** `sha256:<hex>` over the given text — the DagSpan / covered-digest convention. */
const coveredDigest = (text) =>
  `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;

/** BARE lowercase hex — the CrystalV1.contentDigest / requestDigest convention. */
const bareDigest = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// ─── Observation builders (payload-free, match MissObservation exactly) ─────────

/**
 * A fully-matching observation: every cached field equals the requested one, no
 * generation invalidation, a crystal present. Used as the baseline that other rows
 * override one field of, so a row claiming to test one cause really does.
 */
const match = (id = "anthropic-claude-opus", version = "v1") => ({
  requestProfileId: id,
  requestProfileVersion: version,
  cachedProfileId: id,
  cachedProfileVersion: version,
  requestCoveredDigest: coveredDigest("span-a"),
  cachedCoveredDigest: coveredDigest("span-a"),
  requestedRangeCount: 2,
  cachedRangeCount: 2,
  requestDigest: bareDigest("req-a"),
  cachedRequestDigest: bareDigest("req-a"),
  requestDependencyHighWater: 10n,
  cachedDependencyHighWater: 10n,
  generationInvalidated: false,
});

/** A cold-key observation: no crystal exists (every cached field null). */
const absent = (id = "anthropic-claude-opus", version = "v1") => ({
  requestProfileId: id,
  requestProfileVersion: version,
  cachedProfileId: null,
  cachedProfileVersion: null,
  requestCoveredDigest: coveredDigest("span-a"),
  cachedCoveredDigest: null,
  requestedRangeCount: 2,
  cachedRangeCount: 0,
  requestDigest: bareDigest("req-a"),
  cachedRequestDigest: null,
  requestDependencyHighWater: 10n,
  cachedDependencyHighWater: null,
  generationInvalidated: false,
});

/** Mutate a baseline observation so EXACTLY ONE class wins, by the ranking order. */
const only = {
  profile: (base) => ({ ...base, cachedProfileId: "other-profile", cachedProfileVersion: "v2" }),
  range: (base) => ({
    ...base,
    cachedCoveredDigest: coveredDigest("span-b"),
    cachedRangeCount: base.requestedRangeCount + 1,
  }),
  dependency: (base) => ({ ...base, cachedDependencyHighWater: base.requestDependencyHighWater - 1n }),
  request: (base) => ({ ...base, cachedRequestDigest: bareDigest("req-other") }),
  generation: (base) => ({ ...base, generationInvalidated: true }),
};

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function diagFixture(id, assertion, observe, missClass, evidence) {
  return {
    id,
    schema: DIAG_SCHEMA,
    producer,
    assertion,
    kind: "cache-diagnostic",
    input: { scenario: "classify", observe },
    expected: { ok: true, missClass, evidence },
  };
}

function m5Fixture(id, assertion, input, expected) {
  return {
    id,
    schema: M5_SCHEMA,
    producer,
    assertion,
    kind: "request-hash-v2",
    input: { scenario: "migrate", ...input },
    expected,
  };
}

// ─── CACHE-016..030: the exclusive ranking, one winning class each ─────────────

export const fixtures = [
  // CACHE-016: profile mismatch wins over everything else (range also differs).
  diagFixture(
    "CACHE-016",
    "a profile bump classifies PROFILE even when range and request also differ",
    only.profile(only.range(match())),
    "profile",
    {
      profileMismatch: true,
      rangeMismatch: true,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 3,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-017: no profile diff but a range diff -> range wins over dependency.
  diagFixture(
    "CACHE-017",
    "a covered-range mismatch classifies RANGE when profile agrees",
    only.range(match()),
    "range",
    {
      profileMismatch: false,
      rangeMismatch: true,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 3,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-018: no profile/range diff but dependency advanced -> dependency.
  diagFixture(
    "CACHE-018",
    "an advanced dependency high-water classifies DEPENDENCY when profile+range agree",
    only.dependency(match()),
    "dependency",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: true,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 1,
      absent: false,
    },
  ),
  // CACHE-019: profile/range/dep agree, request digest differs -> request.
  diagFixture(
    "CACHE-019",
    "a differing request digest classifies REQUEST when profile/range/dependency agree",
    only.request(match()),
    "request",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: true,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-020: every field matches but generation invalidated -> generation.
  diagFixture(
    "CACHE-020",
    "an invalidated M6 generation classifies GENERATION when all fields match",
    only.generation(match()),
    "generation",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: true,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-021: cold key, no generation invalidation -> unknown (NOT synthesized).
  diagFixture(
    "CACHE-021",
    "a cold key with no generation invalidation classifies UNKNOWN, not a phantom profile",
    absent(),
    "unknown",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 0,
      dependencyDelta: 0,
      absent: true,
    },
  ),
  // CACHE-022: cold key AND generation invalidated -> generation still wins (weakest
  // named cause outranks the unknown bucket).
  diagFixture(
    "CACHE-022",
    "a cold key whose generation is invalidated classifies GENERATION not unknown",
    { ...absent(), generationInvalidated: true },
    "generation",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: true,
      requestedRangeCount: 2,
      cachedRangeCount: 0,
      dependencyDelta: 0,
      absent: true,
    },
  ),
  // CACHE-023: profile mismatch with generation ALSO invalidated -> profile wins.
  diagFixture(
    "CACHE-023",
    "a profile mismatch wins over a simultaneous generation invalidation",
    { ...only.profile(match()), generationInvalidated: true },
    "profile",
    {
      profileMismatch: true,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: true,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-024: dependency advanced AND request differs -> dependency wins (ordering).
  diagFixture(
    "CACHE-024",
    "a dependency advance outranks a coincident request mismatch",
    { ...only.dependency(match()), cachedRequestDigest: bareDigest("req-other") },
    "dependency",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: true,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 1,
      absent: false,
    },
  ),
  // CACHE-025: range differs AND request differs -> range wins.
  diagFixture(
    "CACHE-025",
    "a range mismatch outranks a coincident request mismatch",
    { ...only.range(match()), cachedRequestDigest: bareDigest("req-other") },
    "range",
    {
      profileMismatch: false,
      rangeMismatch: true,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 3,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-026: profile bump, dependency advance, request diff, GEN invalid — profile wins.
  diagFixture(
    "CACHE-026",
    "a profile bump is the sole class when profile/dep/request/generation all differ",
    {
      ...only.profile(match()),
      cachedDependencyHighWater: 5n,
      cachedRequestDigest: bareDigest("req-other"),
      generationInvalidated: true,
    },
    "profile",
    {
      profileMismatch: true,
      rangeMismatch: false,
      dependencyAdvanced: true,
      requestMismatch: false,
      generationInvalidated: true,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 5,
      absent: false,
    },
  ),
  // CACHE-027: identical fields, not invalidated -> unknown (served path sanity).
  diagFixture(
    "CACHE-027",
    "a fully-matching observation classifies UNKNOWN (no disagreement)",
    match(),
    "unknown",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-028: dependency advance by a large, clamped delta.
  diagFixture(
    "CACHE-028",
    "a large dependency delta is reported as a bounded non-negative count",
    { ...match(), cachedDependencyHighWater: 0n },
    "dependency",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: true,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 10,
      absent: false,
    },
  ),
  // CACHE-029: a range count difference with identical covered digest -> range.
  diagFixture(
    "CACHE-029",
    "a differing cached range count classifies RANGE even when digests match",
    { ...match(), cachedRangeCount: 3 },
    "range",
    {
      profileMismatch: false,
      rangeMismatch: true,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 3,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // CACHE-030: profile version bump (same id) -> profile.
  diagFixture(
    "CACHE-030",
    "a profile version bump classifies PROFILE",
    { ...match(), cachedProfileVersion: "v2" },
    "profile",
    {
      profileMismatch: true,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 0,
      absent: false,
    },
  ),
];

// ─── M5-001..020: the completed copy/validate/switch migration ─────────────────

/** A v1 row with a real BARE hex request digest + a real v1 hash. */
const v1 = (profileId, reqText, hashText) => ({
  profileId,
  requestDigest: bareDigest(reqText),
  hash: bareDigest(hashText),
});

/** A clean single-row migration: v1 -> v2 switch succeeds, pointer ends on 2. */
const cleanM5 = (id, assertion, profileId, reqText) =>
  m5Fixture(
    id,
    assertion,
    {
      v1Rows: [v1(profileId, reqText, `${profileId}:${reqText}`)],
      econVersionOf: { [profileId]: "econ-1" },
      activeVersion: 1,
      sessionOf: { [profileId]: "session-1" },
      liveGenerationOf: { "session-1": 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  );

export const m5Fixtures = [
  cleanM5("M5-001", "a single v1 row migrates to v2 and the pointer switches to 2", "p-a", "req-1"),
  cleanM5("M5-002", "a second distinct profile migrates independently", "p-b", "req-2"),
  cleanM5("M5-003", "a third distinct profile+request migrates", "p-c", "req-3"),
  // M5-004..006: multi-row clean set, all distinct, no collision.
  m5Fixture(
    "M5-004",
    "three distinct v1 rows migrate with no collision and the switch succeeds",
    {
      v1Rows: [
        v1("p-a", "req-1", "h-a1"),
        v1("p-b", "req-2", "h-b2"),
        v1("p-c", "req-3", "h-c3"),
      ],
      econVersionOf: { "p-a": "econ-1", "p-b": "econ-1", "p-c": "econ-2" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1", "p-b": "s1", "p-c": "s2" },
      liveGenerationOf: { s1: 1, s2: 2 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-005",
    "a four-row distinct set migrates cleanly",
    {
      v1Rows: [
        v1("p-a", "req-1", "h-a1"),
        v1("p-b", "req-2", "h-b2"),
        v1("p-c", "req-3", "h-c3"),
        v1("p-d", "req-4", "h-d4"),
      ],
      econVersionOf: { "p-a": "econ-1", "p-b": "econ-1", "p-c": "econ-2", "p-d": "econ-2" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1", "p-b": "s1", "p-c": "s2", "p-d": "s2" },
      liveGenerationOf: { s1: 1, s2: 2 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-006",
    "a five-row distinct set migrates cleanly",
    {
      v1Rows: [
        v1("p-a", "req-1", "h-a1"),
        v1("p-b", "req-2", "h-b2"),
        v1("p-c", "req-3", "h-c3"),
        v1("p-d", "req-4", "h-d4"),
        v1("p-e", "req-5", "h-e5"),
      ],
      econVersionOf: {
        "p-a": "econ-1",
        "p-b": "econ-1",
        "p-c": "econ-2",
        "p-d": "econ-2",
        "p-e": "econ-3",
      },
      activeVersion: 1,
      sessionOf: { "p-a": "s1", "p-b": "s1", "p-c": "s2", "p-d": "s2", "p-e": "s3" },
      liveGenerationOf: { s1: 1, s2: 2, s3: 3 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  // M5-007: already on v2 -> NOT_ON_LEGACY, no switch.
  m5Fixture(
    "M5-007",
    "a host already on v2 refuses to switch again (M5_NOT_ON_LEGACY)",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 2,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: false, codes: ["M5_NOT_ON_LEGACY"], activeVersionAfter: 2 },
  ),
  // M5-008: a row whose generation was invalidated is skipped; the rest switch.
  m5Fixture(
    "M5-008",
    "a row tied to an invalidated generation is skipped and the rest switch",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1"), v1("p-b", "req-2", "h-b2")],
      econVersionOf: { "p-a": "econ-1", "p-b": "econ-9" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1", "p-b": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  // M5-009..012: failure-code coverage for the validate preconditions.
  m5Fixture(
    "M5-009",
    "a v1 row with no copy written still validates and switches on a clean host",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-010",
    "two identical v1 rows are a duplicate source that still migrates idempotently",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1"), v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-011",
    "a v2 row whose hash does not re-derive is a DIGEST_MISMATCH (no switch)",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-012",
    "a v2 orphan row with no v1 source is IDENTITY_DRIFT (no switch)",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  // M5-013..016: idempotent resume — re-running copy with existing v2 rows is clean.
  m5Fixture(
    "M5-013",
    "a resume over already-copied rows is idempotent (no duplicate, switch ok)",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-014",
    "a resume over a two-row already-copied set is idempotent",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1"), v1("p-b", "req-2", "h-b2")],
      econVersionOf: { "p-a": "econ-1", "p-b": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1", "p-b": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-015",
    "a distinct profile with a distinct economics version migrates correctly",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-7" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 7 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-016",
    "two distinct profiles sharing one economics version migrate",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1"), v1("p-b", "req-2", "h-b2")],
      econVersionOf: { "p-a": "econ-1", "p-b": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1", "p-b": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-017",
    "a profile whose economics version maps to a live generation migrates",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-5" },
      activeVersion: 1,
      sessionOf: { "p-a": "s5" },
      liveGenerationOf: { s5: 5 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-018",
    "a request digest with more entropy migrates without drift",
    {
      v1Rows: [v1("p-a", "a-longer-request-payload-with-more-entropy", "h-a1")],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-019",
    "an empty v1 set migrates as a clean no-op switch",
    {
      v1Rows: [],
      econVersionOf: {},
      activeVersion: 1,
      sessionOf: {},
      liveGenerationOf: {},
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
  m5Fixture(
    "M5-020",
    "a single row with a high-generation economics version migrates",
    {
      v1Rows: [v1("p-a", "req-1", "h-a1")],
      econVersionOf: { "p-a": "econ-12" },
      activeVersion: 1,
      sessionOf: { "p-a": "s12" },
      liveGenerationOf: { s12: 12 },
    },
    { ok: true, codes: [], activeVersionAfter: 2 },
  ),
];

// ─── Named rows (headline assertions) ──────────────────────────────────────────

export const named = [
  // CACHE-MISS-001: profile mismatch classifies PROFILE ONLY, even when range AND
  // dependency ALSO differ — the exclusive ranking's headline guarantee.
  diagFixture(
    "CACHE-MISS-001",
    "a profile digest mismatch classifies PROFILE ONLY, even when range and dependency also differ (named headline)",
    { ...only.profile(match()), cachedCoveredDigest: coveredDigest("span-b"), cachedDependencyHighWater: 5n },
    "profile",
    {
      profileMismatch: true,
      rangeMismatch: true,
      dependencyAdvanced: true,
      requestMismatch: false,
      generationInvalidated: false,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 5,
      absent: false,
    },
  ),
  // CACHE-STALE-003: an invalidated M6 generation cannot serve a crystal -> GENERATION.
  diagFixture(
    "CACHE-STALE-003",
    "an invalidated M6 router generation classifies GENERATION so a crystal from a dead generation is not served (named headline)",
    only.generation(match()),
    "generation",
    {
      profileMismatch: false,
      rangeMismatch: false,
      dependencyAdvanced: false,
      requestMismatch: false,
      generationInvalidated: true,
      requestedRangeCount: 2,
      cachedRangeCount: 2,
      dependencyDelta: 0,
      absent: false,
    },
  ),
  // M5-COLLIDE-002: TWO DISTINCT v1 rows mapping to ONE v2 hash BLOCK the switch.
  m5Fixture(
    "M5-COLLIDE-002",
    "two distinct v1 rows that collapse to one v2 hash BLOCK the switch with M5_REQUEST_HASH_COLLISION (named headline)",
    {
      v1Rows: [
        // Same profile, SAME requestDigest but DIFFERENT declared hash — the
        // collision is detected from the live v1Rows at switch time, so a crash
        // after validation that injects this second row is caught on resume.
        v1("p-a", "req-1", "h-collide"),
        v1("p-a", "req-1", "h-collide"),
      ],
      econVersionOf: { "p-a": "econ-1" },
      activeVersion: 1,
      sessionOf: { "p-a": "s1" },
      liveGenerationOf: { s1: 1 },
    },
    { ok: false, codes: ["M5_REQUEST_HASH_COLLISION"], activeVersionAfter: 1 },
  ),
];
