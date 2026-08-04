// VC5A planner fixtures (`conformance/vector-cortex/v2/planner/`).
//
// Owner VC5A (PlanV1 / budgeted 0/1 portfolio). Each fixture declares a budget
// admission or selection condition the acceptance test executes against the REAL
// planner module (src/vector-cortex/planner/{portfolio,manifest}.js), no mocks.
// `input.candidates` names a candidate set the test materializes together with a
// `tokenBudget`; `expected.ok` pins the accepted plan (optionally its exact
// `selected` ids / `tokenTotal`) or the exact failure `code`
// (MANDATORY_CLOSURE_OVER_BUDGET / PLN_INVALID_BUDGET /
// PLN_MANIFEST_DIGEST_MISMATCH).
//
// PLN-001..020 pin budget admission (mandatory-first, framing added by VC5A on
// top of VC4C's content-only estimate), 0/1 selection within the remaining
// budget, ratio ordering with source-seq/id tie-breaks, and the never-exceed
// invariant. The NAMED rows pin the sprint's headline assertions:
// PLN-MANDATORY-002 (101 mandatory tokens under budget 100 demotes to C) and
// PLN-TIE-003 (equal ratios choose lower source seq then ID bytes).
//
// Framing note: the default profile is {perNode:4, overhead:8}. Fixtures that
// pin an exact token total state budgets that account for that framing, and the
// `zero-framing` candidate sets use {perNode:0, overhead:0} so a fixture can pin
// raw content arithmetic without the envelope.

import { producer } from "./common.mjs";

const PLANNER_SCHEMA = "schemas/planner-fixture.schema.json";

function plannerFixture(id, assertion, input, expected) {
  return { id, schema: PLANNER_SCHEMA, producer, assertion, kind: "planner", input, expected };
}

export const fixtures = [
  // ── Mandatory closure + budget admission (PLN-001..008) ────────────────────
  plannerFixture("PLN-001", "a mandatory closure that fits is admitted in full",
    { scenario: "plan-mandatory-fits", candidates: "mandatory-only", tokenBudget: 100, zeroFraming: true },
    { ok: true, selected: ["m1", "m2"], tokenTotal: 30 }),
  plannerFixture("PLN-002", "mandatory tokens exceeding the budget return MANDATORY_CLOSURE_OVER_BUDGET",
    { scenario: "plan-mandatory-over", candidates: "mandatory-101", tokenBudget: 100, zeroFraming: true },
    { ok: false, code: "MANDATORY_CLOSURE_OVER_BUDGET", mandatoryPreserved: true }),
  plannerFixture("PLN-003", "an over-budget mandatory closure never drops evidence",
    { scenario: "plan-mandatory-evidence", candidates: "mandatory-101", tokenBudget: 100, zeroFraming: true },
    { ok: false, code: "MANDATORY_CLOSURE_OVER_BUDGET", mandatoryPreserved: true }),
  plannerFixture("PLN-004", "framing cost is added on top of the VC4C content-only estimate",
    { scenario: "plan-framing-added", candidates: "mandatory-only", tokenBudget: 100 },
    { ok: true, tokenTotal: 46 }),
  plannerFixture("PLN-005", "mandatory cost exactly equal to the budget is admitted",
    { scenario: "plan-mandatory-exact", candidates: "mandatory-only", tokenBudget: 30, zeroFraming: true },
    { ok: true, tokenTotal: 30 }),
  plannerFixture("PLN-006", "mandatory cost one token over the budget is rejected",
    { scenario: "plan-mandatory-one-over", candidates: "mandatory-only", tokenBudget: 29, zeroFraming: true },
    { ok: false, code: "MANDATORY_CLOSURE_OVER_BUDGET" }),
  plannerFixture("PLN-007", "a negative budget rejects with PLN_INVALID_BUDGET",
    { scenario: "plan-negative-budget", candidates: "mandatory-only", tokenBudget: -1 },
    { ok: false, code: "PLN_INVALID_BUDGET" }),
  plannerFixture("PLN-008", "a zero budget with a non-empty mandatory closure demotes",
    { scenario: "plan-zero-budget", candidates: "mandatory-only", tokenBudget: 0, zeroFraming: true },
    { ok: false, code: "MANDATORY_CLOSURE_OVER_BUDGET" }),

  // ── 0/1 portfolio selection (PLN-009..016) ─────────────────────────────────
  plannerFixture("PLN-009", "optional candidates fill the remaining budget by utility-per-token",
    { scenario: "plan-optional-ratio", candidates: "ratio", tokenBudget: 20, zeroFraming: true },
    { ok: true, selected: ["hi", "mid"], tokenTotal: 20 }),
  plannerFixture("PLN-010", "an optional candidate that does not fit is omitted, not truncated",
    { scenario: "plan-optional-omitted", candidates: "ratio", tokenBudget: 10, zeroFraming: true },
    { ok: true, selected: ["hi"], omittedOverBudget: true }),
  plannerFixture("PLN-011", "equal ratios choose the lower source seq first",
    { scenario: "plan-tie-source-seq", candidates: "tie-seq", tokenBudget: 10, zeroFraming: true },
    { ok: true, selected: ["early"], firstSelected: "early" }),
  plannerFixture("PLN-012", "equal ratios and equal source seq choose lower ID bytes",
    { scenario: "plan-tie-id-bytes", candidates: "tie-id", tokenBudget: 10, zeroFraming: true },
    { ok: true, selected: ["aaa"], firstSelected: "aaa" }),
  plannerFixture("PLN-013", "selection is 0/1 — a candidate is never partially taken",
    { scenario: "plan-zero-one", candidates: "indivisible", tokenBudget: 15, zeroFraming: true },
    { ok: true, tokenTotal: 10, noPartialSelection: true }),
  plannerFixture("PLN-014", "the accepted plan token total never exceeds the budget",
    { scenario: "plan-never-exceeds", candidates: "ratio", tokenBudget: 25, zeroFraming: true },
    { ok: true, withinBudget: true }),
  plannerFixture("PLN-015", "a zero-utility candidate is never selected",
    { scenario: "plan-zero-utility", candidates: "zero-utility", tokenBudget: 100, zeroFraming: true },
    { ok: true, omittedZeroUtility: true }),
  plannerFixture("PLN-016", "an optional candidate incompatible with a mandatory node is omitted",
    { scenario: "plan-incompatible", candidates: "incompatible", tokenBudget: 100, zeroFraming: true },
    { ok: true, omittedIncompatible: true }),

  // ── Closure, determinism, manifest identity (PLN-017..020) ─────────────────
  plannerFixture("PLN-017", "the accepted plan is closed — every mandatory node is present",
    { scenario: "plan-closed", candidates: "mixed", tokenBudget: 100, zeroFraming: true },
    { ok: true, planIsClosed: true }),
  plannerFixture("PLN-018", "planning is deterministic across candidate permutation",
    { scenario: "plan-deterministic", candidates: "ratio", tokenBudget: 30, zeroFraming: true, permute: true },
    { ok: true, permutationInvariant: true }),
  plannerFixture("PLN-019", "mutating a node token count after planning fails manifest revalidation",
    { scenario: "plan-manifest-mutation", candidates: "mixed", tokenBudget: 100, zeroFraming: true, mutateTokensAfterPlan: true },
    { ok: false, code: "PLN_MANIFEST_DIGEST_MISMATCH" }),
  plannerFixture("PLN-020", "an unmutated plan passes manifest revalidation",
    { scenario: "plan-manifest-stable", candidates: "mixed", tokenBudget: 100, zeroFraming: true },
    { ok: true, manifestStable: true }),
];

export const named = [
  plannerFixture(
    "PLN-MANDATORY-002",
    "101 mandatory tokens under budget 100 demotes to C (named)",
    { scenario: "plan-mandatory-over", candidates: "mandatory-101", tokenBudget: 100, zeroFraming: true },
    { ok: false, code: "MANDATORY_CLOSURE_OVER_BUDGET", mandatoryPreserved: true, demotesToC: true },
  ),
  plannerFixture(
    "PLN-TIE-003",
    "equal ratios choose lower source seq then ID bytes (named)",
    { scenario: "plan-tie-source-seq", candidates: "tie-seq", tokenBudget: 20, zeroFraming: true },
    { ok: true, selected: ["early", "late"], firstSelected: "early" },
  ),
];
