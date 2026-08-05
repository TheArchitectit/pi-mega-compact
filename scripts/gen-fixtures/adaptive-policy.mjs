// VC8B shadow adaptive policy fixtures
// (`conformance/vector-cortex/v2/adaptive-policy/`).
//
// Owner VC8B (evaluatePolicy / evaluateShadow / migratePressureV2). The
// acceptance test feeds these verbatim into the REAL production modules
// (src/vector-cortex/controller/{policy,shadow}.js and
// src/vector-cortex/migrations/pressure-v2.js), no mocks.
//
// BOUNDED BY CONSTRUCTION. Every policy row declares its bound window and the
// expected post-clamp budget, so a regression that widened the clamp would
// change the manifest bytes rather than pass silently. Unknown pressure labels
// are represented as REJECTIONS carrying their exact failure code — they must
// never map onto a neighbouring level.

import { producer } from "./common.mjs";

const POLICY_SCHEMA = "schemas/policy-decision-fixture.schema.json";
const SHADOW_SCHEMA = "schemas/policy-shadow-fixture.schema.json";
const PRESSURE_SCHEMA = "schemas/pressure-v2-fixture.schema.json";

const LEVELS = ["low", "medium", "high", "ultra", "mega"];
/** Multipliers mirroring PRESSURE_FACTOR in controller/policy.ts. */
const FACTOR = { low: 1, medium: 1, high: 0.75, ultra: 0.5, mega: 0.25 };
/** Actions mirroring PRESSURE_ACTION in controller/policy.ts. */
const ACTION = {
  low: "admit",
  medium: "admit",
  high: "dampen",
  ultra: "defer",
  mega: "reject",
};

/** The clamp, mirrored so expected values are DERIVED, never hand-written. */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** The reason selection, mirroring reasonFor() in controller/policy.ts. */
function reasonFor(level, requested, clamped, min, max) {
  if (clamped === max && requested > max) return "budget_clamped_high";
  if (clamped === min && requested < min) return "budget_clamped_low";
  if (level === "mega" || level === "ultra") return "pressure_critical";
  if (level === "high") return "pressure_elevated";
  return "within_bounds";
}

function policyFixture(id, input, expected) {
  return {
    id,
    producer,
    assertion:
      "evaluatePolicy yields an allowed action with the budget clamped into the configured window",
    kind: "policy-decision",
    schema: POLICY_SCHEMA,
    input,
    expected,
  };
}

function shadowFixture(id, assertion, input, expected) {
  return {
    id,
    producer,
    assertion,
    kind: "policy-shadow",
    schema: SHADOW_SCHEMA,
    input,
    expected,
  };
}

function pressureFixture(id, assertion, input, expected) {
  return {
    id,
    producer,
    assertion,
    kind: "pressure-v2",
    schema: PRESSURE_SCHEMA,
    input,
    expected,
  };
}

/** Build one POL row with a DERIVED expected decision. */
function policyRow(n, level, requestedBudget, minBudget, maxBudget) {
  const id = `POL-${String(n).padStart(3, "0")}`;
  const adjusted = requestedBudget * FACTOR[level];
  const budget = clamp(adjusted, minBudget, maxBudget);
  return policyFixture(
    id,
    {
      decisionId: `dec-${n}`,
      sessionId: `sess-${n}`,
      pressure: level,
      requestedBudget,
      bounds: { minBudget, maxBudget },
      ts: "2026-01-01T00:00:00Z",
    },
    {
      ok: true,
      action: ACTION[level],
      budget,
      pressure: level,
      reason: reasonFor(level, adjusted, budget, minBudget, maxBudget),
    },
  );
}

// POL-001..025 — a sweep over the five canonical levels crossed with budgets
// below, inside, and above the window, so every (level, clamp-side) pairing is
// pinned. Rows 021..025 are the rejection rows: unknown labels.
const fixtures = [];
let n = 0;

// POL-001..020: four budget positions per level (below / low-inside /
// high-inside / above), all expected to be bounded.
const BUDGETS = [
  [50, 100, 1000], // below the floor
  [200, 100, 1000], // inside, low
  [900, 100, 1000], // inside, high
  [5000, 100, 1000], // above the ceiling
];
for (const level of LEVELS) {
  for (const [requested, min, max] of BUDGETS) {
    n += 1;
    fixtures.push(policyRow(n, level, requested, min, max));
  }
}

// POL-021..025: unknown pressure labels reject with POL_PRESSURE_UNKNOWN and
// are never coerced onto a neighbouring level.
const UNKNOWN_LABELS = ["extreme", "critical", "LOW", "none", ""];
for (const label of UNKNOWN_LABELS) {
  n += 1;
  const id = `POL-${String(n).padStart(3, "0")}`;
  fixtures.push(
    policyFixture(
      id,
      {
        decisionId: `dec-${n}`,
        sessionId: `sess-${n}`,
        pressure: label,
        requestedBudget: 500,
        bounds: { minBudget: 100, maxBudget: 1000 },
        ts: "2026-01-01T00:00:00Z",
      },
      { ok: false, code: "POL_PRESSURE_UNKNOWN" },
    ),
  );
}

// M7-001..015 — pressure-v2 migration rows.
const m7Fixtures = [];

// M7-001..005: each canonical label migrates and switches the pointer.
LEVELS.forEach((level, i) => {
  const id = `M7-${String(i + 1).padStart(3, "0")}`;
  m7Fixtures.push(
    pressureFixture(
      id,
      "a canonical legacy pressure label migrates and the pointer switches to v2",
      {
        scenario: "migrate",
        v1Rows: [
          { sessionId: "sess-1", label: level, effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
        ],
      },
      { ok: true, activeVersionAfter: 2, rowCount: 1 },
    ),
  );
});

// M7-006..010: unknown labels reject and KEEP the legacy pointer.
["extreme", "critical", "LOW", "none", "urgent"].forEach((label, i) => {
  const id = `M7-${String(i + 6).padStart(3, "0")}`;
  m7Fixtures.push(
    pressureFixture(
      id,
      "an unknown legacy pressure label rejects the migration and keeps the old pointer",
      {
        scenario: "migrate",
        v1Rows: [
          { sessionId: "sess-1", label, effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
        ],
      },
      { ok: false, code: "M7_PRESSURE_UNKNOWN", activeVersionAfter: 1 },
    ),
  );
});

// M7-011: a multi-row canonical store migrates wholesale.
m7Fixtures.push(
  pressureFixture(
    "M7-011",
    "every canonical row in a multi-session store migrates in one pass",
    {
      scenario: "migrate",
      v1Rows: LEVELS.map((level, i) => ({
        sessionId: `sess-${i + 1}`,
        label: level,
        effectiveSeq: 1,
        ts: "2026-01-01T00:00:00Z",
      })),
    },
    { ok: true, activeVersionAfter: 2, rowCount: 5 },
  ),
);

// M7-012: an empty legacy store migrates cleanly.
m7Fixtures.push(
  pressureFixture(
    "M7-012",
    "an empty legacy store migrates cleanly and switches the pointer",
    { scenario: "migrate", v1Rows: [] },
    { ok: true, activeVersionAfter: 2, rowCount: 0 },
  ),
);

// M7-013: a resumed migration is idempotent (no duplicate rows).
m7Fixtures.push(
  pressureFixture(
    "M7-013",
    "a resumed migration writes no duplicate rows and still switches",
    {
      scenario: "resume",
      v1Rows: [
        { sessionId: "sess-1", label: "high", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
        { sessionId: "sess-1", label: "ultra", effectiveSeq: 2, ts: "2026-01-01T00:00:00Z" },
      ],
    },
    { ok: true, activeVersionAfter: 2, rowCount: 2 },
  ),
);

// M7-014: one bad label among good ones rejects the WHOLE migration.
m7Fixtures.push(
  pressureFixture(
    "M7-014",
    "a single uncanonical label rejects the whole migration",
    {
      scenario: "migrate",
      v1Rows: [
        { sessionId: "sess-1", label: "low", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
        { sessionId: "sess-2", label: "bogus", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
      ],
    },
    { ok: false, code: "M7_PRESSURE_UNKNOWN", activeVersionAfter: 1 },
  ),
);

// M7-015: the sprint's failure injection — kill after copy, insert an unknown
// legacy pressure, resume; validation rejects and the OLD pointer survives.
m7Fixtures.push(
  pressureFixture(
    "M7-015",
    "an unknown pressure inserted AFTER the copy is re-detected at switch time and the old pointer is kept",
    {
      scenario: "inject-after-copy",
      v1Rows: [
        { sessionId: "sess-1", label: "low", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
        { sessionId: "sess-2", label: "high", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
      ],
      injectedRow: {
        sessionId: "sess-late",
        label: "catastrophic",
        effectiveSeq: 1,
        ts: "2026-01-02T00:00:00Z",
      },
    },
    { ok: false, code: "M7_PRESSURE_UNKNOWN", activeVersionAfter: 1 },
  ),
);

// Named fixtures for the sprint's headline assertions.
const named = [
  // POL-CLAMP-001: both clamp sides pinned in ONE row so a one-sided
  // regression cannot pass.
  policyFixture(
    "POL-CLAMP-001",
    {
      decisionId: "dec-clamp",
      sessionId: "sess-clamp",
      pressure: "low",
      requestedBudget: 1,
      bounds: { minBudget: 100, maxBudget: 1000 },
      ts: "2026-01-01T00:00:00Z",
      alternateRequestedBudget: 99999,
    },
    {
      ok: true,
      action: "admit",
      budget: 100,
      pressure: "low",
      reason: "budget_clamped_low",
      alternateBudget: 1000,
      alternateReason: "budget_clamped_high",
    },
  ),
  // POL-SHADOW-002: the shadow leaves the canonical prompt digest unchanged.
  shadowFixture(
    "POL-SHADOW-002",
    "a shadow decision leaves the canonical prompt digest unchanged and reports zero live mutations",
    {
      promptBytes: "system: be concise\nuser: summarize the vector cortex design",
      inputs: [
        {
          decisionId: "dec-s1",
          sessionId: "sess-s1",
          pressure: "high",
          requestedBudget: 800,
          bounds: { minBudget: 100, maxBudget: 1000 },
          ts: "2026-01-01T00:00:00Z",
        },
      ],
    },
    { ok: true, promptUnchanged: true, liveMutations: 0, evaluated: 1 },
  ),
  // M7-PRESSURE-003: an unknown label rejects the migration row.
  pressureFixture(
    "M7-PRESSURE-003",
    "an unknown pressure label rejects the migration row and keeps the legacy pointer",
    {
      scenario: "migrate",
      v1Rows: [
        { sessionId: "sess-1", label: "catastrophic", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
      ],
    },
    { ok: false, code: "M7_PRESSURE_UNKNOWN", activeVersionAfter: 1 },
  ),
];

export { fixtures, m7Fixtures, named };
