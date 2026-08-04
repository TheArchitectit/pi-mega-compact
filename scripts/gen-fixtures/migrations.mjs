// VC1C M4 minhash-v2 migration fixtures (`conformance/vector-cortex/v2/migrations/`).
// Owner VC1C: the MinHashV2 versioned signature store (batch/backfill by
// checkpoint id, verify, switch active version, cross-version reject). Each
// fixture's `input` describes the v1 index + checkpoint set and the migration
// scenario to run; the tests execute it against a real M4Host and assert
// `expected`. IDs: M4-001..008 (migration lifecycle + failure codes) and the
// named M4-RESUME-003 / M4-DUP-001.

import { producer } from "./common.mjs";

const MIG_SCHEMA = "schemas/minhash-migration.schema.json";

function migFixture(id, assertion, input, expected) {
  return { id, schema: MIG_SCHEMA, producer, assertion, kind: "minhash-v2", input, expected };
}

// M4-001: full backfill + verify + switch on a small v1 index succeeds.
const m4_001 = migFixture(
  "M4-001",
  "M4 backfill->verify->switch activates v2 on a balanced checkpoint set",
  { scenario: "full", checkpoints: ["c1", "c2", "c3"], activeStarting: 1 },
  { ok: true, activeVersion: 2, count: 3 },
);

// M4-002: backfill is idempotent — a second backfill writes no duplicate rows.
const m4_002 = migFixture(
  "M4-002",
  "M4 repeated backfill is idempotent (no duplicate v2 rows)",
  { scenario: "repeat-backfill", checkpoints: ["c1", "c2"], activeStarting: 1 },
  { ok: true, activeVersion: 2, count: 2 },
);

// M4-003: an interrupted backfill leaves v1 active (old authority retained).
const m4_003 = migFixture(
  "M4-003",
  "M4 interruption before switch leaves v1 active (old authority retained)",
  { scenario: "halt-before-switch", checkpoints: ["c1", "c2"], activeStarting: 1 },
  { ok: true, activeVersion: 1, halted: true },
);

// M4-004: a partial backfill (missing checkpoint) fails M4_BACKFILL_PARTIAL.
const m4_004 = migFixture(
  "M4-004",
  "M4 a partial backfill reports M4_BACKFILL_PARTIAL",
  { scenario: "partial-backfill", checkpoints: ["c1", "c2"], present: ["c1"], activeStarting: 1 },
  { ok: false, code: "M4_BACKFILL_PARTIAL" },
);

// M4-005: a stored row with a corrupted digest fails M4_DIGEST_MISMATCH.
const m4_005 = migFixture(
  "M4-005",
  "M4 a row whose stored v2 digest re-hashes differently fails M4_DIGEST_MISMATCH",
  { scenario: "bad-digest", checkpoints: ["c1"], activeStarting: 1 },
  { ok: false, code: "M4_DIGEST_MISMATCH" },
);

// M4-006: a duplicate v2 row for one checkpoint fails the exact-once count.
const m4_006 = migFixture(
  "M4-006",
  "M4 a duplicated v2 row fails exact-once count (M4_COUNT_MISMATCH)",
  { scenario: "duplicate-row", checkpoints: ["c1"], activeStarting: 1 },
  { ok: false, code: "M4_COUNT_MISMATCH" },
);

// M4-007: a stored v2 row carrying a non-v2 version tag fails MINHASH_VERSION_MISMATCH.
const m4_007 = migFixture(
  "M4-007",
  "M4 a stored row at a wrong version fails MINHASH_VERSION_MISMATCH",
  { scenario: "bad-version-row", checkpoints: ["c1"], activeStarting: 1 },
  { ok: false, code: "MINHASH_VERSION_MISMATCH" },
);

// M4-008: repeated full migration (backfill+verify+switch) switches once, idempotent.
const m4_008 = migFixture(
  "M4-008",
  "M4 a repeated full migration switches once and is idempotent",
  { scenario: "repeat-full", checkpoints: ["c1"], activeStarting: 1 },
  { ok: true, activeVersion: 2, count: 1 },
);

// M4-RESUME-003: an interrupted backfill resumes without duplicate signatures or
// active-pointer drift (active stays v1 until a verified switch).
const m4Resume = migFixture(
  "M4-RESUME-003",
  "interrupted backfill resumes without duplicate signatures or active-pointer drift",
  { scenario: "resume-after-halt", checkpoints: ["c1", "c2"], activeStarting: 1 },
  { ok: true, activeVersion: 2, count: 2, noDuplicates: true },
);

// M4-DUP-001: two equal-byte checkpoints are DISTINCT v2 rows (versioned beside
// v1; identity by checkpoint id, never deduped).
const m4Dup = migFixture(
  "M4-DUP-001",
  "two equal-content checkpoints remain two v2 rows (identity by checkpoint id)",
  { scenario: "dup-content", checkpoints: ["d1", "d2"], texts: ["same", "same"], activeStarting: 1 },
  { ok: true, activeVersion: 2, count: 2, equalDigests: true },
);

export const fixtures = [
  m4_001, m4_002, m4_003, m4_004, m4_005, m4_006, m4_007, m4_008,
];
export const named = [m4Resume, m4Dup];
