// VC6C self-healing derived controller fixtures
// (`conformance/vector-cortex/v2/healing-controller/`).
//
// Owner VC6C (detectGaps / planRebuild / computeBackoff / isRateLimited /
// rebuildGeneration / switchPointer). Each fixture carries the controller's view
// of one or more derived subsystems (`input.states`) plus an injected monotonic
// clock (`input.nowMs`), which the acceptance test feeds verbatim into the REAL
// heal modules (src/vector-cortex/heal/{controller,rebuild}.js), no mocks.
//
// `expected` pins the repair verdict:
//
//   ok            — the scenario produced the planned/switched outcome intended.
//   code          — the HEAL_REPAIR_* / HEAL_REBUILD_* code the controller or
//                   rebuild returned (failure and suppression rows).
//   plannedCount  — how many subsystems detectGaps produced a plan for.
//   ranges        — the exact [seqStart, seqEnd] each plan covers, in plan order,
//                   so a controller that planned the WRONG WINDOW (off-by-one at
//                   the derived frontier, or a jump to the spool tail) fails even
//                   when the plan COUNT is right.
//   switched      — whether the pointer moved (rebuild rows only).
//   generation    — the live generation AFTER the scenario.
//
// SCENARIO DISPATCH. `input.scenario` selects which real entry point the
// acceptance test drives:
//   "detect"  — detectGaps(states, nowMs), asserting plannedCount + ranges.
//   "backoff" — computeBackoff(subsystem, attempt), asserting determinism.
//   "rebuild" — rebuildGeneration + switchPointer over input.rebuild.
//
// CLOCKS ARE INJECTED, NEVER READ. Every timestamp here is an explicit number
// converted to BigInt by the loader. VC6C's controller takes `nowMs` as an
// argument precisely so the rate-limit and backoff rows are reproducible; a
// fixture that depended on Date.now() could not pin HEAL-RATE-002 at all.
//
// DIGESTS ARE COMPUTED, NEVER HAND-WRITTEN. Rebuild rows carry base64 source
// bytes and a real SHA-256 over those exact bytes, so the corpus is
// self-consistent by construction. HEAL-041 is the one deliberate exception — it
// pins a root digest that does NOT match its bytes, which is the whole point of
// that row (verification must fail and the pointer must NOT move).
//
// HEAL-031..045 are the registered VC6C conformance rows; the three NAMED rows
// (HEAL-GAP-001 / HEAL-RATE-002 / HEAL-SWITCH-003) pin the sprint's headline
// assertions (a topology high-water of 8 against an authority of 10 plans exactly
// 9..10 / a second rebuild inside 5 minutes is suppressed / a verified root
// switches the pointer exactly once).

import { createHash } from "node:crypto";

import { producer } from "./common.mjs";

const HEALING_SCHEMA = "schemas/healing-controller-fixture.schema.json";

const b64 = (s) => Buffer.from(s).toString("base64");
const hexOf = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");

/** Five minutes, matching REPAIR_RATE_LIMIT_MS. */
const RATE_LIMIT_MS = 5 * 60_000;

/**
 * One derived subsystem's state. `authorityHighWater` is READ by the controller
 * and never written — the fixtures cannot express an authority mutation because
 * the production contract has no such field.
 */
const state = (subsystem, derived, authority, extra = {}) => ({
  subsystem,
  derivedHighWater: derived,
  authorityHighWater: authority,
  lastRebuildAt: null,
  generation: 1,
  mode: "A",
  ...extra,
});

function healingFixture(id, assertion, input, expected) {
  return {
    id,
    schema: HEALING_SCHEMA,
    producer,
    assertion,
    kind: "healing-controller",
    input,
    expected,
  };
}

/** A detect-gaps scenario over N subsystems at an injected clock. */
const detect = (scenario, states, nowMs = 1_000_000) => ({
  scenario,
  mode: "detect",
  nowMs,
  states,
});

/** A rebuild scenario: materialize `text` into a new generation, then switch. */
const rebuild = (scenario, text, expectedDigest, currentGen = 1, mode = "A") => ({
  scenario,
  mode: "rebuild",
  nowMs: 1_000_000,
  states: [],
  rebuild: {
    subsystem: "topology",
    generation: currentGen + 1,
    currentGeneration: currentGen,
    sourceBytesBase64: b64(text),
    expectedDigest,
    triadMode: mode,
  },
});

export const fixtures = [
  // ── Gap detection (HEAL-031..036) ─────────────────────────────────────────
  healingFixture(
    "HEAL-031",
    "a derived subsystem behind the authority plans exactly the unbuilt seq window",
    detect("gap-single", [state("topology", 5, 9)]),
    { ok: true, plannedCount: 1, ranges: [[6, 9]] },
  ),
  healingFixture(
    "HEAL-032",
    "a derived subsystem level with the authority plans nothing (no gap)",
    detect("no-gap", [state("topology", 9, 9)]),
    { ok: true, plannedCount: 0, ranges: [] },
  ),
  healingFixture(
    "HEAL-033",
    "several lagging subsystems each plan their own independent gap window",
    detect("gap-multi", [
      state("topology", 5, 9),
      state("shards", 0, 3),
      state("closure", 7, 8),
    ]),
    { ok: true, plannedCount: 3, ranges: [[6, 9], [1, 3], [8, 8]] },
  ),
  healingFixture(
    "HEAL-034",
    "only the lagging subsystems plan; caught-up siblings are skipped in place",
    detect("gap-mixed", [
      state("topology", 9, 9),
      state("shards", 2, 6),
      state("closure", 4, 4),
    ]),
    { ok: true, plannedCount: 1, ranges: [[3, 6]] },
  ),
  healingFixture(
    "HEAL-035",
    "a derived source AHEAD of authority plans nothing (never an inverted range)",
    detect("derived-ahead", [state("topology", 12, 9)]),
    { ok: true, plannedCount: 0, ranges: [] },
  ),
  healingFixture(
    "HEAL-036",
    "a one-seq gap plans a single-element window (frontier off-by-one guard)",
    detect("gap-single-seq", [state("topology", 8, 9)]),
    { ok: true, plannedCount: 1, ranges: [[9, 9]] },
  ),

  // ── Authority freeze + mode C (HEAL-037..039) ─────────────────────────────
  healingFixture(
    "HEAL-037",
    "a frozen authority refuses to plan — derived lag is CORRECT during an outage",
    detect("authority-frozen", [
      state("topology", 5, 9, { authorityFrozen: true }),
    ]),
    {
      ok: false,
      code: "HEAL_REPAIR_AUTHORITY_FROZEN",
      plannedCount: 0,
      ranges: [],
    },
  ),
  healingFixture(
    "HEAL-038",
    "a frozen authority blocks only its own subsystem; healthy siblings still plan",
    detect("frozen-one-of-two", [
      state("topology", 5, 9, { authorityFrozen: true }),
      state("shards", 1, 4),
    ]),
    {
      ok: false,
      code: "HEAL_REPAIR_AUTHORITY_FROZEN",
      plannedCount: 1,
      ranges: [[2, 4]],
    },
  ),
  healingFixture(
    "HEAL-039",
    "a mode-C subsystem (derived state disabled) is never re-planned",
    detect("mode-c-disabled", [state("topology", 5, 9, { mode: "C" })]),
    { ok: true, plannedCount: 0, ranges: [] },
  ),

  // ── Rate limiting (HEAL-040) ──────────────────────────────────────────────
  healingFixture(
    "HEAL-040",
    "a rebuild 1 minute ago is suppressed; the 5-minute window has not elapsed",
    detect("rate-limited", [
      state("topology", 5, 9, { lastRebuildAt: 1_000_000 - 60_000 }),
    ]),
    {
      ok: false,
      code: "HEAL_REPAIR_RATE_LIMITED",
      plannedCount: 0,
      ranges: [],
    },
  ),

  // ── Rebuild verification + pointer switch (HEAL-041..043) ─────────────────
  healingFixture(
    "HEAL-041",
    "a root digest mismatch keeps the OLD pointer and deletes no evidence",
    // Bytes are "rebuilt-state" but the pinned root is over "different-state".
    rebuild("rebuild-digest-mismatch", "rebuilt-state", hexOf("different-state")),
    {
      ok: false,
      code: "HEAL_REPAIR_DIGEST_MISMATCH",
      plannedCount: 0,
      ranges: [],
      switched: false,
      generation: 1,
    },
  ),
  healingFixture(
    "HEAL-042",
    "an empty rebuild is a failure, never an empty success that flips the pointer",
    rebuild("rebuild-empty", "", hexOf("")),
    {
      ok: false,
      code: "HEAL_REBUILD_FAILED",
      plannedCount: 0,
      ranges: [],
      switched: false,
      generation: 1,
    },
  ),
  healingFixture(
    "HEAL-043",
    "mode C performs no rebuild and STATES its loss of old semantic context",
    rebuild("rebuild-mode-c", "rebuilt-state", hexOf("rebuilt-state"), 1, "C"),
    {
      ok: false,
      code: "HEAL_REBUILD_FAILED",
      plannedCount: 0,
      ranges: [],
      switched: false,
      generation: 1,
      semanticLossStated: true,
    },
  ),

  // ── Backoff determinism (HEAL-044..045) ───────────────────────────────────
  healingFixture(
    "HEAL-044",
    "backoff grows exponentially from the 30s base and stays inside the ±10% band",
    {
      scenario: "backoff-growth",
      mode: "backoff",
      nowMs: 1_000_000,
      states: [],
      backoff: { subsystem: "topology", attempts: [0, 1, 2, 3] },
    },
    { ok: true, plannedCount: 0, ranges: [], monotonic: true },
  ),
  healingFixture(
    "HEAL-045",
    "backoff saturates at the 15-minute cap and never exceeds it after jitter",
    {
      scenario: "backoff-cap",
      mode: "backoff",
      nowMs: 1_000_000,
      states: [],
      backoff: { subsystem: "topology", attempts: [10, 20, 30] },
    },
    { ok: true, plannedCount: 0, ranges: [], capped: true },
  ),
];

export const named = [
  healingFixture(
    "HEAL-GAP-001",
    "topology high-water 8 vs authority 10 plans range 9..10 (named headline)",
    detect("named-gap-9-to-10", [state("topology", 8, 10)]),
    { ok: true, plannedCount: 1, ranges: [[9, 10]] },
  ),
  healingFixture(
    "HEAL-RATE-002",
    "a second rebuild inside 5 minutes is suppressed (named headline)",
    detect("named-rate-suppressed", [
      // Rebuilt 1 ms inside the window: the boundary must be exclusive, so a
      // rebuild at exactly now-5min WOULD be allowed but this one must not be.
      state("topology", 8, 10, { lastRebuildAt: 1_000_000 - RATE_LIMIT_MS + 1 }),
    ]),
    {
      ok: false,
      code: "HEAL_REPAIR_RATE_LIMITED",
      plannedCount: 0,
      ranges: [],
    },
  ),
  healingFixture(
    "HEAL-SWITCH-003",
    "a verified root switches the pointer exactly once (named headline)",
    rebuild("named-verified-switch", "rebuilt-state", hexOf("rebuilt-state")),
    {
      ok: true,
      plannedCount: 0,
      ranges: [],
      switched: true,
      generation: 2,
      // Re-applying the SAME plan must not advance again: the switch is
      // monotonic, so a replayed stale plan is refused (exactly once).
      idempotent: true,
    },
  ),
];
