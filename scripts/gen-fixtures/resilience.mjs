// VC0C resilience fixtures TRI-001..030 + named WINDOW/PROBE/FREEZE.
// Owner VC0C (TRIAD_RESILIENCE). kind=breaker rows pin the breaker state
// machine transition/code; kind=spool rows pin the pure-spool verdict. Each
// fixture's `expected.code` is the exact code/verdict the implementation must
// return for the described scenario — the acceptance test re-executes the real
// breaker/spool and asserts parity. TRI-001..015 are breaker transitions;
// TRI-016..030 are spool protocol rows. The three named fixtures
// (TRI-WINDOW-001, TRI-PROBE-002, TRI-FREEZE-003) are the headline acceptance
// cases the conformance section calls out explicitly.

import { producer } from "./common.mjs";

const TRI = "schemas/tri-fixture.schema.json";

function tri(id, kind, assertion, expected, input) {
  return { id, producer, schema: TRI, kind, assertion, expected, input: input ?? {} };
}

export const fixtures = [
  // ── Breaker transitions: TRI-001..015 ────────────────────────────────────
  tri("TRI-001", "breaker", "twentieth failed attempt inside 60s opens CLOSED_A -> OPEN_B (perf)", { code: "TRI_OPEN_B", state: "OPEN_B" }, { scenario: "20 A-failures inside the 60s window trip the breaker" }),
  tri("TRI-002", "breaker", "three successful probes promote PROBE_A -> CLOSED_A after healthy residence", { code: "OK", state: "CLOSED_A" }, { scenario: "cooldown waits, 5min healthy residence, then 3 probes promote" }),
  tri("TRI-003", "breaker", "B failure demotes OPEN_B -> OPEN_C (independent B is fallback; when B trips, only C remains)", { code: "TRI_OPEN_C", state: "OPEN_C" }, { scenario: "after A opened, a B failure trips to OPEN_C" }),
  tri("TRI-004", "breaker", "correctness trip on the FIRST failure (rate < perf threshold) opens the breaker once min attempts met", { code: "TRI_OPEN_B", state: "OPEN_B" }, { scenario: "20 correctness failures at rate < perf threshold trip to OPEN_B" }),
  tri("TRI-005", "breaker", "expired cooldown may PROBE, never directly promote", { code: "PROBE_A", state: "PROBE_A" }, { scenario: "after cooldown expiry the state is PROBE not CLOSED_A" }),
  tri("TRI-006", "breaker", "promotion hysteresis: high window failure rate blocks promotion despite N probes (stays in PROBE_B via the B-restage path)", { code: "PROBE_AGAIN", state: "PROBE_B" }, { scenario: "probes succeed but window failure rate >= 2% blocks promotion" }),
  tri("TRI-007", "breaker", "promotion hysteresis: p95 over the latency budget blocks promotion (stays in PROBE_B)", { code: "PROBE_AGAIN", state: "PROBE_B" }, { scenario: "probe latency p95 exceeds the 50ms budget" }),
  tri("TRI-008", "breaker", "backoff is exponential with deterministic +-10% jitter from the subsystem digest; retryDelayMs is exposed on the OPEN_C record", { code: "BACKOFF", state: "OPEN_C" }, { scenario: "retryDelay grows 30s*2^attempt capped at 15min with jitter" }),
  tri("TRI-009", "breaker", "manual halt requires a reason and unwires only via explicit admin reset", { code: "TRI_MANUAL_HALT", state: "MANUAL_HALT" }, { scenario: "authority/digest corruption halts all subsystems; reset returns to OPEN_B" }),
  tri("TRI-010", "breaker", "manual reset clears cooldown but NEVER evidence", { code: "RESET_RETAINED", state: "OPEN_B" }, { scenario: "after reset, attempts/failures are retained, cooldown cleared" }),
  tri("TRI-011", "breaker", "rolling window prunes old attempts beyond the 60s window", { code: "WINDOW_PRUNE", state: "CLOSED_A" }, { scenario: "old window entries age out; the breaker relaxes" }),
  tri("TRI-012", "breaker", "mode A failure demotes to B; OUTPUT_INVALID surfaces when A succeeds but validation fails", { code: "TRI_OUTPUT_INVALID", state: "OPEN_B" }, { scenario: "A returns but fails validation -> demotion" }),
  tri("TRI-013", "breaker", "mode C failures are retryable continuity failures and never advance the breaker", { code: "TRI_EXEC_THREW", state: "OPEN_C" }, { scenario: "both A and B unavailable; C throws -> retryable C failure, breaker unchanged" }),
  tri("TRI-014", "breaker", "A-execution throw trips to OPEN_B once the window exceeds min attempts", { code: "TRI_EXEC_THREW", state: "OPEN_B" }, { scenario: "20 throwing A-executes open the breaker" }),
  tri("TRI-015", "breaker", "PROBE_B promotes to OPEN_B (not CLOSED_A) after cooldown + 3 probes", { code: "OPEN_B", state: "OPEN_B" }, { scenario: "B open state recovers to CLOSED_A via a B-restage probe" }),

  // ── Spool protocol: TRI-016..030 ─────────────────────────────────────────
  tri("TRI-016", "spool", "append fsyncs before acknowledging SPOOLED; committed drain advances the high-water", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-016", ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "drain", commit: "ok" }] }),
  tri("TRI-017", "spool", "duplicate same id+digest is idempotent-acknowledged (never manual halt); the contiguous high-water still advances", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-017", prequeue: true, ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "drain", commit: "idempotent" }] }),
  tri("TRI-018", "spool", "gap in sequence rejects with SPOOL_MANUAL_HALT (TRI_SPOOL_GAP)", { code: "SPOOL_MANUAL_HALT", reason: "TRI_SPOOL_GAP" }, { session: "sp-018", ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "append", seq: 3, eventId: "e3" }, { op: "drain", commit: "gap" }] }),
  tri("TRI-019", "spool", "conflicting digest for same id halts with SPOOL_MANUAL_HALT (TRI_SPOOL_CONFLICT)", { code: "SPOOL_MANUAL_HALT", reason: "TRI_SPOOL_CONFLICT" }, { session: "sp-019", prequeue: true, ops: [{ op: "append", seq: 1, eventId: "e1", conflict: true }, { op: "drain", commit: "conflict" }] }),
  tri("TRI-020", "spool", "torn trailing frame (crash mid-write) replays only unacknowledged frames on reopen", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-020", toreTail: true, ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "reopen" }, { op: "drain", commit: "ok" }] }),
  tri("TRI-021", "spool", "ack crash: kill between fsync and ack re-drains only frames strictly beyond the recovered high-water", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-021", ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "killBeforeAck" }, { op: "reopen" }, { op: "drain", commit: "ok" }] }),
  tri("TRI-022", "spool", "authority outage freezes the derived frontier at the contiguous high-water", { code: "FRONTIER_FROZEN" }, { session: "sp-022", outage: true, ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "assertFrozen" }] }),
  tri("TRI-023", "spool", "freezeFrontier records the frozen flag at the current high-water", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-023", ops: [{ op: "freeze" }, { op: "assertFrozen" }] }),
  tri("TRI-024", "spool", "empty drain after a fully-committed spool returns SPOOL_COMMITTED at the acked high-water", { code: "SPOOL_COMMITTED", committedSeq: 0 }, { session: "sp-024", ops: [{ op: "drainEmpty", commit: "ok" }] }),
  tri("TRI-025", "spool", "multi-frame drain commits contiguous seq in order and advances the high-water", { code: "SPOOL_COMMITTED", committedSeq: 3 }, { session: "sp-025", ops: [{ op: "append", seq: 1, eventId: "a" }, { op: "append", seq: 2, eventId: "b" }, { op: "append", seq: 3, eventId: "c" }, { op: "drain", commit: "ok" }] }),
  tri("TRI-026", "spool", "frames are sorted strictly by (seq, eventId) before drain, so out-of-order appends commit", { code: "SPOOL_COMMITTED", committedSeq: 2 }, { session: "sp-026", ops: [{ op: "append", seq: 2, eventId: "b" }, { op: "append", seq: 1, eventId: "a" }, { op: "drain", commit: "ok" }] }),
  tri("TRI-027", "spool", "unknown schema header throws TRI_SPOOL_SCHEMA on reopen (corrupt header is never silently accepted)", { code: "TRI_SPOOL_SCHEMA" }, { session: "sp-027", badSchema: true, ops: [{ op: "reopen" }] }),
  tri("TRI-028", "spool", "idempotent re-drain after reopen does not double-commit; high-water stays put (acknowledged)", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-028", prequeue: true, ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "drain", commit: "ok" }, { op: "reopen" }, { op: "drain", commit: "idempotent" }] }),
  tri("TRI-029", "spool", "unknown manifest row otherwise: a spool row claims wrong schema but still validates", { code: "SPOOL_COMMITTED", committedSeq: 0 }, { session: "sp-029", ops: [{ op: "schemaOnly" }] }),
  tri("TRI-030", "spool", "each frame carries length-prefixed seq/eventId/bytes/sha256/crc32c; a multi-byte eventId appends and drains losslessly", { code: "SPOOL_COMMITTED", committedSeq: 1 }, { session: "sp-030", ops: [{ op: "append", seq: 1, eventId: "multi-byte-é", bytes: "raw" }, { op: "drain", commit: "ok" }] }),
];

// Headline named fixtures the conformance section calls out explicitly.
export const named = [
  tri(
    "TRI-WINDOW-001",
    "breaker",
    "TRI-WINDOW-001: twentieth failed attempt inside the 60s window opens the breaker (OPEN_B).",
    { code: "TRI_OPEN_B", state: "OPEN_B" },
    { scenario: "the 20th A-failure, all within 60s, trips CLOSED_A -> OPEN_B" },
  ),
  tri(
    "TRI-PROBE-002",
    "breaker",
    "TRI-PROBE-002: three successful probes (after cooldown + healthy residence) enter CLOSED_A.",
    { code: "OK", state: "CLOSED_A" },
    { scenario: "cooldown waits, 5min healthy residence, then exactly 3 probes promote" },
  ),
  tri(
    "TRI-FREEZE-003",
    "spool",
    "TRI-FREEZE-003: authority outage preserves the prior frontier (high-water freezes while frames append).",
    { code: "FRONTIER_FROZEN" },
    { session: "sp-freeze-003", outage: true, ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "assertFrozen" }] },
  ),
];
