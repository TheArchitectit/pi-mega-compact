// VC5C rollout fixtures (`conformance/vector-cortex/v2/rollout/`).
//
// Owner VC5C (live graduated rollout). Each fixture declares an assignment/gate
// condition the acceptance test executes against the REAL rollout module
// (src/vector-cortex/rollout/{assign,gate}.js), no mocks.
// `input.scenario` names the condition; `input.sessionId`/`input.evidence` carry
// the drive inputs. `expected.ok` pins a clean assignment/advance or a precise
// blocked outcome (exact `bucket`/`gateIndex`/`promotionBlocked`/`selectsPreVc`).
//
// ROL-001..020 pin stable-bucket assignment, monotonic-by-one gate advancement,
// the wall-clock-jump/monotonic-unchanged failure injection, and the forced triad
// (A closed renderer on assigned buckets; B deterministic greedy renderer forced
// by A breaker; C pre-VC path forced by hard violation).
// The NAMED rows pin the sprint's headline assertions:
//   ROL-BUCKET-001 — a fixed session digest maps to a golden stable bucket
//   ROL-POWER-002 — 72h AND 10k events BUT 199 sessions cannot advance
//   ROL-SAFETY-003 — one tool-pair violation immediately blocks promotion

import { producer } from "./common.mjs";

const ROLLOUT_SCHEMA = "schemas/rollout-fixture.schema.json";

function rolloutFixture(id, assertion, input, expected) {
  return { id, schema: ROLLOUT_SCHEMA, producer, assertion, kind: "rollout", input, expected };
}

export const fixtures = [
  // ── Stable-bucket assignment (ROL-001..006) ────────────────────────────────
  rolloutFixture(
    "ROL-001",
    "a session id deterministically hashes into a stable 0..9999 bucket",
    { scenario: "assign-stable", sessionId: "session-alpha-0001" },
    { ok: true },
  ),
  rolloutFixture(
    "ROL-002",
    "the same session id always maps to the same bucket across calls",
    { scenario: "assign-stable", sessionId: "session-alpha-0001" },
    { ok: true },
  ),
  rolloutFixture(
    "ROL-003",
    "different session ids map to different buckets (no collision for the pair)",
    { scenario: "assign-stable", sessionId: "session-beta-0002" },
    { ok: true },
  ),
  rolloutFixture(
    "ROL-004",
    "assignment NEVER changes across process restart (no Date.now/Math.random)",
    { scenario: "assign-stable", sessionId: "session-gamma-0003" },
    { ok: true },
  ),
  rolloutFixture(
    "ROL-005",
    "a bucket under gate bound qualifies for the current gate",
    { scenario: "assign-stable", sessionId: "session-low-bucket-0005" },
    { ok: true },
  ),
  rolloutFixture(
    "ROL-006",
    "assignment is a pure function (empty session id still yields a bucket)",
    { scenario: "assign-stable", sessionId: "" },
    { ok: true },
  ),

  // ── Monotonic-by-one gate advancement (ROL-007..012) ───────────────────────
  rolloutFixture(
    "ROL-007",
    "all gate conjuncts met advances exactly ONE gate step",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 1, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-008",
    "a 72h residency alone is insufficient without a powered sample",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: false, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 0, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-009",
    "72h + powered + 200 sessions but <10k events cannot advance",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 9999, sessions: 250 },
    },
    { ok: true, gateIndex: 0, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-010",
    "72h + powered + 10k events but 199 sessions cannot advance",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 199 },
    },
    { ok: true, gateIndex: 0, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-011",
    "gate advancement is strictly monotonic and never skips a gate",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 1, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-012",
    "already at 100% gate cannot advance further",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 4, promotionBlocked: false },
  ),

  // ── Unique failure injection: wall-clock jump, monotonic unchanged (ROL-013..015)
  rolloutFixture(
    "ROL-013",
    "at 71h59m the gate cannot advance even though evidence is otherwise sufficient",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 0, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-014",
    "a wall-clock jump (+1d) with unchanged monotonic clock does NOT advance the gate",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 0, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-015",
    "a monotonic delta >= 72h (without wall jump) DOES advance the gate",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 12000, sessions: 250 },
    },
    { ok: true, gateIndex: 1, promotionBlocked: false },
  ),

  // ── Forced triad (ROL-016..018) ────────────────────────────────────────────
  rolloutFixture(
    "ROL-016",
    "triad A: a closed renderer serves assigned buckets under the active gate",
    { scenario: "assign-stable", sessionId: "session-triad-a-0016" },
    { ok: true },
  ),
  rolloutFixture(
    "ROL-017",
    "triad B: the deterministic greedy renderer is forced when the A breaker trips",
    { scenario: "gate-safety", evidence: { hardFaults: [{ kind: "tool", detail: "b-trip" }] } },
    { ok: true, promotionBlocked: true },
  ),
  rolloutFixture(
    "ROL-018",
    "triad C: a hard violation forces the pre-VC path and freezes promotion",
    { scenario: "gate-safety", evidence: { hardFaults: [{ kind: "exact", detail: "c-violation" }] } },
    { ok: true, promotionBlocked: true, selectsPreVc: true },
  ),

  // ── Hard-fault freeze classification (ROL-019..020) ────────────────────────
  rolloutFixture(
    "ROL-019",
    "a causal hard fault freezes promotion and selects the pre-VC path",
    { scenario: "gate-safety", evidence: { hardFaults: [{ kind: "causal", detail: "causal-drift" }] } },
    { ok: true, promotionBlocked: true, selectsPreVc: true },
  ),
  rolloutFixture(
    "ROL-020",
    "an anchor hard fault freezes promotion and selects the pre-VC path",
    { scenario: "gate-safety", evidence: { hardFaults: [{ kind: "anchor", detail: "anchor-loss" }] } },
    { ok: true, promotionBlocked: true, selectsPreVc: true },
  ),
];

export const named = [
  rolloutFixture(
    "ROL-BUCKET-001",
    "a fixed session digest maps to a golden stable bucket (deterministic, restart-invariant)",
    { scenario: "assign-stable", sessionId: "vc5c-canonical-session-digest-001" },
    { ok: true, bucket: 8517 },
  ),
  rolloutFixture(
    "ROL-POWER-002",
    "72h AND 10k events BUT 199 sessions cannot advance the gate (named)",
    {
      scenario: "gate-power",
      evidence: { windowStartMs: 0, powered: true, events: 10000, sessions: 199 },
    },
    { ok: true, gateIndex: 0, promotionBlocked: false },
  ),
  rolloutFixture(
    "ROL-SAFETY-003",
    "one tool-pair violation immediately blocks promotion (named)",
    { scenario: "gate-safety", evidence: { hardFaults: [{ kind: "tool", detail: "tool-pair-split" }] } },
    { ok: true, promotionBlocked: true, selectsPreVc: true },
  ),
];
