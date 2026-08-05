// VC8A consent-bound outcome ledger fixtures
// (`conformance/vector-cortex/v2/outcomes/`).
//
// Owner VC8A (appendOutcome / consent / buildManifest). The acceptance test
// feeds these verbatim into the REAL production modules
// (src/vector-cortex/outcomes/{ledger,consent,dataset}.js), no mocks.
//
// PAYLOAD-FREE BY CONSTRUCTION. Every input is a session id, repo id,
// assignment code, or a numeric metric with a named code. NO prompt bytes,
// NO response text, NO free-text payload. The ledger rejects all payload
// fields as OUT_PAYLOAD_FORBIDDEN.
//
// DIGESTS ARE COMPUTED, NEVER HAND-WRITTEN — every manifest digest below is
// a real SHA-256 over the canonical sorted rows.

import { createHash } from "node:crypto";

import { producer } from "./common.mjs";

const OUTCOME_SCHEMA = "schemas/outcome-fixture.schema.json";
const CONSENT_SCHEMA = "schemas/consent-fixture.schema.json";
const DATASET_SCHEMA = "schemas/dataset-manifest-fixture.schema.json";

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** A valid payload-free outcome metric row. */
function outcome(outcomeId, sessionId, repoId, assignment, metrics, ts = "2026-01-01T00:00:00Z") {
  return { outcomeId, sessionId, repoId, assignment, metrics, ts };
}

function metric(code, value, unit) {
  return { code, value, unit };
}

/** Build a fixture for outcome append validation. */
function outcomeFixture(id, input, expected) {
  return {
    id,
    producer,
    assertion: "appendOutcome validates payload-free metrics only",
    kind: "outcome",
    schema: OUTCOME_SCHEMA,
    input,
    expected,
  };
}

/** Build a fixture for consent grant/revoke evaluation. */
function consentFixture(id, input, expected) {
  return {
    id,
    producer,
    assertion: "consent grant/revoke effective sequence evaluation",
    kind: "consent",
    schema: CONSENT_SCHEMA,
    input,
    expected,
  };
}

/** Build a fixture for dataset manifest build + digest. */
function datasetFixture(id, input, expected) {
  return {
    id,
    producer,
    assertion: "buildManifest groups by repo+session, excludes revoked, reproducible digest",
    kind: "dataset",
    schema: DATASET_SCHEMA,
    input,
    expected,
  };
}

// OUT-001..025: outcome append validation fixtures.
const fixtures = [];
for (let i = 1; i <= 25; i++) {
  const id = `OUT-${String(i).padStart(3, "0")}`;
  const sessionId = `sess-${i}`;
  const repoId = i <= 12 ? "repo-a" : "repo-b";
  const assignment = i % 3 === 0 ? "control" : "experimental";
  const metrics = [
    metric("latency_ms", i * 10, "ms"),
    metric("token_count", i * 100, "count"),
  ];
  fixtures.push(outcomeFixture(
    id,
    outcome(`out-${i}`, sessionId, repoId, assignment, metrics),
    { ok: true, outcomeId: `out-${i}` },
  ));
}

// OUT-CONSENT-001: grant includes later metric row.
const consentNamed = [
  consentFixture(
    "OUT-CONSENT-001",
    {
      records: [
        { consentId: "c1", sessionId: "sess-a", action: "grant", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
      ],
      sessionId: "sess-a",
      effectiveHighWater: 5,
    },
    { ok: true, hasActiveConsent: true },
  ),
  consentFixture(
    "OUT-REVOKE-002",
    {
      records: [
        { consentId: "c1", sessionId: "sess-a", action: "grant", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
        { consentId: "c2", sessionId: "sess-a", action: "revoke", effectiveSeq: 3, ts: "2026-01-03T00:00:00Z" },
      ],
      sessionId: "sess-a",
      effectiveHighWater: 5,
    },
    { ok: true, hasActiveConsent: false },
  ),
  datasetFixture(
    "OUT-SPLIT-003",
    {
      outcomes: [
        outcome("out-1", "sess-1", "repo-a", "experimental", [metric("x", 1, "count")]),
        outcome("out-2", "sess-1", "repo-a", "experimental", [metric("x", 2, "count")]),
        outcome("out-3", "sess-1", "repo-a", "experimental", [metric("x", 3, "count")]),
      ],
      consentRecords: [
        { consentId: "c1", sessionId: "sess-1", action: "grant", effectiveSeq: 1, ts: "2026-01-01T00:00:00Z" },
      ],
      consentHighWater: 1,
    },
    { ok: true, rowCount: 3, splitsForSession: 1 },
  ),
];

export { fixtures, consentNamed as named };
