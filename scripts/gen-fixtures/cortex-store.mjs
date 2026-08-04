// VC3A cortex-store fixtures
// (`conformance/vector-cortex/v2/cortex-store/`).
//
// Owner VC3A (CortexReader/Writer/Admin, CortexRecordV1). Each fixture declares
// a cortex-store behavior scenario the acceptance test executes against the REAL
// capability-gated store / sqlite producers (no mocks). `input.scenario` names
// the condition; `expected.ok` pins the successful behavior or the exact failure
// `code`.
//
// CTX-001..010 are the registered VC3A conformance rows; the three NAMED rows
// (CTX-CAP-001 / CTX-KEY-002 / CTX-REBUILD-003) pin the sprint's headline
// assertions (writer has no query/admin member; same id at different algorithm
// versions stays distinct; shuffled inserts yield an identical root digest).

import { producer } from "./common.mjs";

const CTX_SCHEMA = "schemas/cortex-store-fixture.schema.json";

function ctxFixture(id, assertion, input, expected) {
  return { id, schema: CTX_SCHEMA, producer, assertion, kind: "cortex-store", input, expected };
}

export const fixtures = [
  // CTX-001 — capability separation: the writer exposes append only.
  ctxFixture(
    "CTX-001",
    "the cortex writer exposes append only (no query or admin member)",
    { scenario: "writer-append-only" },
    { ok: true },
  ),
  // CTX-002 — same id at different algorithm versions stays distinct (CTX-KEY).
  ctxFixture(
    "CTX-002",
    "the same id at different algorithm versions remains distinct records",
    { scenario: "distinct-algorithm-versions" },
    { ok: true },
  ),
  // CTX-003 — shuffled inserts yield an identical single root digest (CTX-REBUILD).
  ctxFixture(
    "CTX-003",
    "shuffled record insertion yields an identical single root digest",
    { scenario: "shuffle-order-digest" },
    { ok: true },
  ),
  // CTX-004 — an exact key + exact payload is an idempotent ack.
  ctxFixture(
    "CTX-004",
    "re-appending an exact key + payload digest is an idempotent acknowledge",
    { scenario: "idempotent-ack" },
    { ok: true },
  ),
  // CTX-005 — the same key with a different digest is a conflict (immutable).
  ctxFixture(
    "CTX-005",
    "the same composite key with a different payload digest is a CTX_KEY_CONFLICT",
    { scenario: "key-conflict" },
    { ok: false, code: "CTX_KEY_CONFLICT" },
  ),
  // CTX-006 — writes are nonfatal; a storage failure degrades and host continues.
  ctxFixture(
    "CTX-006",
    "a storage failure on append returns CTX_APPEND_FAILED and the host continues",
    { scenario: "nonfatal-append" },
    { ok: false, code: "CTX_APPEND_FAILED" },
  ),
  // CTX-007 — the admin rebuilds + switches generations, retaining evidence.
  ctxFixture(
    "CTX-007",
    "the admin rebuilds and switches generations without deleting evidence",
    { scenario: "generation-rebuild-switch" },
    { ok: true },
  ),
  // CTX-008 — the reader-only topology summary never leaks writer/admin surfaces.
  ctxFixture(
    "CTX-008",
    "the reader-only topology summary exposes aggregates without writer/admin leakage",
    { scenario: "reader-only-summary" },
    { ok: true },
  ),
  // CTX-009 — rebuild rejects a payload digest mismatch (authority corruption).
  ctxFixture(
    "CTX-009",
    "rebuild rejects a record whose payload digest does not match its bytes",
    { scenario: "payload-digest-mismatch" },
    { ok: false, code: "CTX_PAYLOAD_DIGEST_MISMATCH" },
  ),
  // CTX-010 — the derived frontier is the max sourceHighWater across records.
  ctxFixture(
    "CTX-010",
    "the derived frontier equals the max sourceHighWater across accepted records",
    { scenario: "derived-frontier" },
    { ok: true },
  ),
];

export const named = [
  // CTX-CAP-001 — writer has no query or admin member (negative compile).
  ctxFixture(
    "CTX-CAP-001",
    "the writer has no query or admin member (capability gating)",
    { scenario: "capability-gating" },
    { ok: true },
  ),
  // CTX-KEY-002 — same id at different algorithm versions remains distinct.
  ctxFixture(
    "CTX-KEY-002",
    "the same id at different algorithm versions remains distinct",
    { scenario: "distinct-algorithm-versions" },
    { ok: true },
  ),
  // CTX-REBUILD-003 — shuffled inserts yield an identical root digest.
  ctxFixture(
    "CTX-REBUILD-003",
    "shuffled inserts yield an identical single root digest",
    { scenario: "shuffle-order-digest" },
    { ok: true },
  ),
];
