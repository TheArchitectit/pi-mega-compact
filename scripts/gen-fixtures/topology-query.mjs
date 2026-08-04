// VC3C topology-query fixtures
// (`conformance/vector-cortex/v2/topology-query/`).
//
// Owner VC3C (TopologyQueryV1 / RouterKeyV2). Each fixture declares a
// key-encoding / invalidation / staleness / triad-demotion condition the
// acceptance test executes against the REAL query layer
// (src/vector-cortex/topology/query.js), no mocks. `input.scenario` names the
// condition; `expected.ok` pins the successful behavior or the exact failure
// `code`.
//
// TOP-021..030 are the registered VC3C topology-query rows; the three NAMED
// rows (M6-KEY-001 / M6-STALE-002 / TOP-QUERY-003) pin the sprint's headline
// assertions (sessions a/aa cannot prefix-collide / old generation misses
// immediately after switch / equal-score target-ID byte order via top-k).

import { producer } from "./common.mjs";

const TQ_SCHEMA = "schemas/topology-query-fixture.schema.json";
const MIG_SCHEMA = "schemas/router-generation-migration.schema.json";

function tqFixture(id, assertion, input, expected) {
  return { id, schema: TQ_SCHEMA, producer, assertion, kind: "topology-query", input, expected };
}

function m6Fixture(id, assertion, input, expected) {
  return { id, schema: MIG_SCHEMA, producer, assertion, kind: "router-generation-v2", input, expected };
}

// M6-001..012 — the router-generation-v2 copy/validate/switch migration rows.
// Each names the old per-session query set + scenario; the acceptance test runs
// the REAL M6 migration against an in-memory M6Host and asserts `expected`.
const m6Fixtures = [
  m6Fixture(
    "M6-001",
    "M6 copy->verify->switch activates v2 on a balanced old query set",
    { scenario: "full", sessions: ["s1", "s2"], activeStarting: 1 },
    { ok: true, activeVersion: 2, count: 3 },
  ),
  m6Fixture(
    "M6-002",
    "M6 repeated copy is idempotent (no duplicate v2 rows)",
    { scenario: "repeat-copy", sessions: ["s1"], activeStarting: 1 },
    { ok: true, activeVersion: 2, count: 2, noDuplicates: true },
  ),
  m6Fixture(
    "M6-003",
    "M6 an interrupted copy resumes without duplicate rows or pointer drift",
    { scenario: "resume-after-halt", sessions: ["s1", "s2"], activeStarting: 1 },
    { ok: true, activeVersion: 2, count: 3, noDuplicates: true },
  ),
  m6Fixture(
    "M6-004",
    "M6 a partial copy reports M6_COPY_PARTIAL",
    { scenario: "partial-copy", sessions: ["s1"], activeStarting: 1 },
    { ok: false, code: "M6_COPY_PARTIAL" },
  ),
  m6Fixture(
    "M6-005",
    "M6 a stored row whose digest re-hashes differently fails M6_DIGEST_MISMATCH",
    { scenario: "bad-digest", sessions: ["s1"], activeStarting: 1 },
    { ok: false, code: "M6_DIGEST_MISMATCH" },
  ),
  m6Fixture(
    "M6-006",
    "M6 a duplicated v2 row fails exact-once count (M6_COUNT_MISMATCH)",
    { scenario: "duplicate-row", sessions: ["s1"], activeStarting: 1 },
    { ok: false, code: "M6_COUNT_MISMATCH" },
  ),
  m6Fixture(
    "M6-007",
    "M6 an undecodable old key fails M6_BAD_OLD_KEY",
    { scenario: "bad-old-key", sessions: ["s1"], activeStarting: 1 },
    { ok: false, code: "M6_BAD_OLD_KEY" },
  ),
  m6Fixture(
    "M6-008",
    "M6 interruption before switch leaves the legacy pointer active",
    { scenario: "halt-before-switch", sessions: ["s1"], activeStarting: 1 },
    { ok: true, activeVersion: 1, halted: true },
  ),
  m6Fixture(
    "M6-009",
    "M6 a row whose structured key claims a different session fails M6_CROSS_SESSION_EVICTION",
    { scenario: "cross-session", sessions: ["s1"], activeStarting: 1 },
    { ok: false, code: "M6_CROSS_SESSION_EVICTION" },
  ),
  m6Fixture(
    "M6-010",
    "M6 a repeated full migration switches once and is idempotent",
    { scenario: "repeat-full", sessions: ["s1"], activeStarting: 1 },
    { ok: true, activeVersion: 2, count: 2, noDuplicates: true },
  ),
  m6Fixture(
    "M6-011",
    "M6 old and new query sets compare equal by structured identity (never string prefix)",
    { scenario: "set-equality", sessions: ["s1", "s2"], activeStarting: 1 },
    { ok: true, activeVersion: 2, count: 3 },
  ),
  m6Fixture(
    "M6-012",
    "M6 sessions a and aa derive distinct rows and never collide at the canonical key level",
    { scenario: "no-key-collision", sessions: ["a", "aa"], activeStarting: 1 },
    { ok: true, activeVersion: 2, noKeyCollision: true },
  ),
];

export const fixtures = [
  // TOP-021 — a RouterKeyV2 round-trips every structured key field.
  tqFixture(
    "TOP-021",
    "a RouterKeyV2 round-trips every structured key field through the length-delimited encoding",
    { scenario: "key-roundtrip", session: "s1", generation: 3, activeGeneration: 3 },
    { ok: true },
  ),
  // TOP-022 — encoded keys order by unsigned bytes (2 < 3 < 256).
  tqFixture(
    "TOP-022",
    "encoded keys order by unsigned bytes so generation 2 < 3 < 256",
    { scenario: "unsigned-byte-order", session: "s1", generation: 2, activeGeneration: 3 },
    { ok: true },
  ),
  // TOP-023 — fixed-arity length-delimited keys never prefix-collide.
  tqFixture(
    "TOP-023",
    "fixed-arity length-delimited keys never make one key a prefix of another",
    { scenario: "no-prefix-arity", session: "a", generation: 1, secondSession: "aa" },
    { ok: true, noCollision: true },
  ),
  // TOP-024 — invalidation matches an exact (session,generation) only.
  tqFixture(
    "TOP-024",
    "invalidation matches an exact (session,generation) and never a prefix or another session",
    { scenario: "invalidation-exact", session: "a", generation: 1, secondSession: "aa" },
    { ok: true },
  ),
  // TOP-025 — a stale generation query is rejected via TOP_GENERATION_STALE demotion.
  tqFixture(
    "TOP-025",
    "a query for a stale generation is rejected (TOP_GENERATION_STALE) and demoted to a fresh scan",
    { scenario: "stale-rejection", session: "s1", generation: 3, activeGeneration: 5 },
    { ok: true, mode: "B" },
  ),
  // TOP-026 — a stale A key forces a fresh linear scan (mode B).
  tqFixture(
    "TOP-026",
    "a stale A key forces a fresh linear scan (mode B)",
    { scenario: "demote-b", session: "s1", generation: 3, activeGeneration: 5 },
    { ok: true, mode: "B" },
  ),
  // TOP-027 — a derived-store outage routes via the authority scan (mode C).
  tqFixture(
    "TOP-027",
    "a derived-store outage routes the query via the authority sequence scan (mode C)",
    { scenario: "mode-c", session: "s1", generation: 3, activeGeneration: 3 },
    { ok: true, mode: "C" },
  ),
  // TOP-028 — a current-generation miss in the index demotes to mode B.
  tqFixture(
    "TOP-028",
    "a mode-A miss at the current generation demotes to a fresh scan, never a fabricated graph",
    { scenario: "mode-a-miss", session: "s1", generation: 3, activeGeneration: 3 },
    { ok: true, mode: "B" },
  ),
  // TOP-029 — 100k generation/invalidation ops yield zero stale results.
  tqFixture(
    "TOP-029",
    "100k generation/invalidation operations yield zero stale results",
    { scenario: "stability-100k", session: "s1", generation: 0, activeGeneration: 32 },
    { ok: true },
  ),
  // TOP-030 — the canonical key digest is stable.
  tqFixture(
    "TOP-030",
    "the canonical key digest is a stable sha256 over the structured key bytes",
    { scenario: "key-digest", session: "s1", generation: 4, activeGeneration: 4 },
    { ok: true },
  ),
  ...m6Fixtures,
];

export const named = [
  // TOP-QUERY-003 — equal scores return target-ID byte order (the build's stable
  // sort at the query/generation level feeds the same unsigned-byte ordering).
  tqFixture(
    "TOP-QUERY-003",
    "equal scores return target-ID byte order via the query/generation unimodal sort",
    { scenario: "equal-score-byte-order", session: "s1", generation: 3, activeGeneration: 3 },
    { ok: true, noCollision: true },
  ),
  // M6-KEY-001 — sessions `a` and `aa` cannot prefix-collide.
  tqFixture(
    "M6-KEY-001",
    "sessions a and aa cannot prefix-collide at the key or invalidation-identity level",
    { scenario: "no-prefix-sessions", session: "a", generation: 1, secondSession: "aa" },
    { ok: true, noCollision: true },
  ),
  // M6-STALE-002 — old generation misses immediately after the switch.
  tqFixture(
    "M6-STALE-002",
    "an old generation misses immediately after the active generation switches",
    { scenario: "stale-after-switch", session: "s1", generation: 4, activeGeneration: 5 },
    { ok: true, mode: "B" },
  ),
];
