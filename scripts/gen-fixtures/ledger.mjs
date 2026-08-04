// VC1B occurrence-ledger + M2 downgrade fixtures.
// Owner VC1B: the neutral occurrence ledger (LedgerReader/Writer/Admin +
// CompatJournalV1) and the M2 occurrence-v2 copy/validate/switch migration (see
// src/vector-cortex/ledger/{store,sqlite,compat-journal}.ts and
// src/vector-cortex/migrations/occurrence-v2.ts). Each fixture's `input`
// describes the v2 ledger to set up and the migration scenario to run; the
// acceptance test executes it against a real store and asserts `expected`.
//
// IDs: M2-001..015 (migration lifecycle + failure codes) and MIG-DOWN-001
// (downgrade export), plus the three named behavior fixtures M2-DUP-001,
// M2-TOOL-002, MIG-DOWN-003.

import { producer, b64bytes } from "./common.mjs";

const LEDGER_SCHEMA = "schemas/ledger-fixture.schema.json";

function ledgerFixture(id, assertion, input, expected) {
  return { id, schema: LEDGER_SCHEMA, producer, assertion, kind: "occurrence-v2", input, expected };
}

function namedLedgerFixture(id, assertion, input, expected) {
  return { id, schema: LEDGER_SCHEMA, producer, assertion, kind: "occurrence-v2", input, expected };
}

// ── M2 lifecycle + failure-code fixtures (M2-001..015) ─────────────────────

// M2-001: full copy/validate/switch on a balanced two-row ledger succeeds.
const m2_001 = ledgerFixture(
  "M2-001",
  "M2 copy/validate/switch on a balanced user/tool-pair ledger succeeds",
  {
    scenario: "full",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("hello")) },
      { seq: 2, eventId: "c9", kind: "tool_call", bytesBase64: b64bytes(new TextEncoder().encode("call")) },
      { seq: 3, eventId: "r1", kind: "tool_result", toolCallId: "c9", bytesBase64: b64bytes(new TextEncoder().encode("result")) },
    ],
  },
  { ok: true, count: 3 },
);

// M2-002: duplicate content at two seq is preserved as two rows (count parity).
const m2_002 = ledgerFixture(
  "M2-002",
  "duplicate-content occurrences migrate with preserved count (not deduped)",
  {
    scenario: "full",
    occurrences: [
      { seq: 1, eventId: "d1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("repeat")) },
      { seq: 2, eventId: "d2", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("repeat")) },
    ],
  },
  { ok: true, count: 2 },
);

// M2-003: an untouched (never-active) ledger refuses downgrade: an old binary may
// only open the exported legacy copy once the journal is active (MIG_DOWN_NOT_ACTIVE).
const m2_003 = ledgerFixture(
  "M2-003",
  "an untouched (never-active) ledger refuses downgrade export (MIG_DOWN_NOT_ACTIVE)",
  { scenario: "not-active-empty", occurrences: [] },
  { ok: false, code: "MIG_DOWN_NOT_ACTIVE" },
);

// M2-004: crash after validate before switch retains the old authority.
const m2_004 = ledgerFixture(
  "M2-004",
  "M2 crash after validated and before switched leaves authority unchanged",
  {
    scenario: "halt-after-validate",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
    ],
  },
  { ok: true, halted: true },
);

// M2-005: resume after a halt switches once without duplicate rows.
const m2_005 = ledgerFixture(
  "M2-005",
  "M2 resume after an interrupted switch is idempotent (no duplicate rows)",
  {
    scenario: "resume-after-halt",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
    ],
  },
  { ok: true, count: 1 },
);

// M2-006: validate before any copy -> M2_COPY_MISSING.
const m2_006 = ledgerFixture(
  "M2-006",
  "M2 validation before copy reports M2_COPY_MISSING (no staged export)",
  {
    scenario: "validate-before-copy",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
    ],
  },
  { ok: false, code: "M2_COPY_MISSING" },
);

// M2-007: active journal validated before the copy phase -> MIG_DOWN_PHASE_UNREACHED.
const m2_007 = ledgerFixture(
  "M2-007",
  "M2 validation before the copy phase reports MIG_DOWN_PHASE_UNREACHED",
  {
    scenario: "validate-before-copy-active",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
    ],
  },
  { ok: false, code: "MIG_DOWN_PHASE_UNREACHED" },
);

// M2-008: malformed representable digest -> MIG_DOWN_DIGEST_MISMATCH.
const m2_008 = ledgerFixture(
  "M2-008",
  "M2 rejects a representable row whose digest is malformed (MIG_DOWN_DIGEST_MISMATCH)",
  {
    scenario: "bad-digest",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
    ],
  },
  { ok: false, code: "MIG_DOWN_DIGEST_MISMATCH" },
);

// M2-009: unrepresented unrepresentable row -> M2_UNREPRESENTABLE_UNLISTED.
const m2_009 = ledgerFixture(
  "M2-009",
  "M2 rejects a downgrade export that omits an unrepresentable row",
  {
    scenario: "unrepresentable-unlisted",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("ok")) },
      { seq: 2, eventId: "bad", kind: "user", bytesBase64: b64bytes(new Uint8Array([0xff])) },
    ],
  },
  { ok: false, code: "M2_UNREPRESENTABLE_UNLISTED" },
);

// M2-010: a tool result with a dangling call is rejected at append (tool identity).
const m2_010 = ledgerFixture(
  "M2-010",
  "a tool RESULT referencing a missing call is rejected EVT_TOOL_CALL_MISSING at append",
  {
    scenario: "append-dangling-tool",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
      { seq: 2, eventId: "r1", kind: "tool_result", toolCallId: "ghost", bytesBase64: b64bytes(new TextEncoder().encode("y")) },
    ],
  },
  { ok: false, code: "EVT_TOOL_CALL_MISSING" },
);

// M2-011: out-of-order seq is rejected EVT_SEQ_REGRESSION at append.
const m2_011 = ledgerFixture(
  "M2-011",
  "a non-contiguous seq is rejected EVT_SEQ_REGRESSION at append",
  {
    scenario: "append-seq-regression",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("a")) },
      { seq: 5, eventId: "u5", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("e")) },
    ],
  },
  { ok: false, code: "EVT_SEQ_REGRESSION" },
);

// M2-012: duplicate (event_id,digest) re-append is acknowledged idempotently.
const m2_012 = ledgerFixture(
  "M2-012",
  "an exact (event_id,digest) re-append is acknowledged idempotently, never duplicated",
  {
    scenario: "idempotent-ack",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("same")) },
      { seq: 0, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("same")) },
    ],
  },
  { ok: true, count: 1 },
);

// M2-013: batch append records a per-input outcome; only accepted rows persist.
const m2_013 = ledgerFixture(
  "M2-013",
  "a mixed batch persists only accepted rows",
  {
    scenario: "batch-outcome",
    occurrences: [
      { seq: 1, eventId: "b1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("a")) },
      { seq: 2, eventId: "b2", kind: "tool_result", toolCallId: "ghost", bytesBase64: b64bytes(new TextEncoder().encode("b")) },
      { seq: 2, eventId: "b3", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("c")) },
    ],
  },
  { ok: true, count: 2 },
);

// M2-014: reader sees exactly what the writer accepted (count/order/digest parity).
const m2_014 = ledgerFixture(
  "M2-014",
  "reader count/order/digest parity with accepted source occurrences",
  {
    scenario: "reader-parity",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("p1")) },
      { seq: 2, eventId: "c9", kind: "tool_call", bytesBase64: b64bytes(new TextEncoder().encode("call")) },
      { seq: 3, eventId: "r1", kind: "tool_result", toolCallId: "c9", bytesBase64: b64bytes(new TextEncoder().encode("result")) },
    ],
  },
  { ok: true, count: 3 },
);

// M2-015: a second full migration is idempotent (switches once, no duplicate rows).
const m2_015 = ledgerFixture(
  "M2-015",
  "a repeated full migration is idempotent (no duplicate rows)",
  {
    scenario: "repeat-full",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("x")) },
    ],
  },
  { ok: true, count: 1 },
);

// ── MIG-DOWN-001 + named behavior fixtures ─────────────────────────────────

// MIG-DOWN-001: a downgrade export produces a NEW lossless legacy copy listing
// any unrepresentable rows.
const migdown001 = namedLedgerFixture(
  "MIG-DOWN-001",
  "downgrade export creates a new legacy copy; unrepresentable rows are listed",
  {
    scenario: "migrate-down",
    occurrences: [
      { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("plain")) },
      { seq: 2, eventId: "bad", kind: "user", bytesBase64: b64bytes(new Uint8Array([0xff])) },
    ],
  },
  { ok: true, unrepresentable: ["bad"] },
);

const m2dup = namedLedgerFixture(
  "M2-DUP-001",
  "same bytes at two seq values create two occurrences",
  {
    scenario: "dup-on-two-seq",
    occurrences: [
      { seq: 1, eventId: "d1", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("identical bytes")) },
      { seq: 2, eventId: "d2", kind: "user", bytesBase64: b64bytes(new TextEncoder().encode("identical bytes")) },
    ],
  },
  { ok: true, count: 2, equalDigests: true },
);

const m2tool = namedLedgerFixture(
  "M2-TOOL-002",
  "result references earlier call c9 exactly once",
  {
    scenario: "tool-ref-once",
    occurrences: [
      { seq: 1, eventId: "c9", kind: "tool_call", bytesBase64: b64bytes(new TextEncoder().encode("call")) },
      { seq: 2, eventId: "r1", kind: "tool_result", toolCallId: "c9", bytesBase64: b64bytes(new TextEncoder().encode("result")) },
    ],
  },
  { ok: true, count: 2, toolCallId: "c9" },
);

const migdown003 = namedLedgerFixture(
  "MIG-DOWN-003",
  "invalid UTF-8 row is listed unrepresentable in the legacy copy",
  {
    scenario: "invalid-utf8-unrepresentable",
    occurrences: [
      { seq: 1, eventId: "bad", kind: "user", bytesBase64: b64bytes(new Uint8Array([0xff, 0xfe])) },
    ],
  },
  { ok: true, unrepresentable: ["bad"] },
);

export const fixtures = [
  m2_001, m2_002, m2_003, m2_004, m2_005, m2_006, m2_007, m2_008,
  m2_009, m2_010, m2_011, m2_012, m2_013, m2_014, m2_015,
];
export const named = [migdown001, m2dup, m2tool, migdown003];
