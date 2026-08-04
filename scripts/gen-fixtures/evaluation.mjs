// VC0A evaluation fixtures EVAL-001..010 (schema kind "metric"/"annotation").

import { producer, b64, sha256Hex } from "./common.mjs";

const ENV = "schemas/eval-fixture.schema.json";

function metricFixture(id, assertion, input, expected) {
  return { id, schema: ENV, producer, assertion, kind: "metric", input, expected };
}

function annotationFixture(id, assertion, input, expected) {
  return { id, schema: ENV, producer, assertion, kind: "annotation", input, expected };
}

// EVAL-001 — canonical ordering across sessions.
const eval001 = metricFixture(
  "EVAL-001",
  "canonical (session,seq,event) ordering baseline",
  [
    { session: "s2", seq: 1, event: "b", value: 10, unit: "count", mode: "A" },
    { session: "s1", seq: 2, event: "a", value: 7, unit: "count", mode: "A" },
    { session: "s1", seq: 1, event: "a", value: 5, unit: "count", mode: "A" },
    { session: "s2", seq: 1, event: "a", value: 9, unit: "count", mode: "B" },
  ],
  { ok: true, order: [["s1", 1, "a"], ["s1", 2, "a"], ["s2", 1, "a"], ["s2", 1, "b"]] },
);

// EVAL-002 — monotonic seq pass across sessions (no rejection).
const eval002 = metricFixture(
  "EVAL-002",
  "monotonic per-session sequence accepted",
  [
    { session: "sA", seq: 1, event: "e1", value: 1, unit: "count", mode: "A" },
    { session: "sB", seq: 1, event: "e1", value: 1, unit: "count", mode: "B" },
    { session: "sA", seq: 2, event: "e2", value: 2, unit: "count", mode: "A" },
  ],
  { ok: true, order: [["sA", 1, "e1"], ["sA", 2, "e2"], ["sB", 1, "e1"]] },
);

// EVAL-003 — unknown unit rejected.
const eval003 = metricFixture(
  "EVAL-003",
  "unknown unit rejected with EVAL_UNIT_UNKNOWN",
  [{ session: "s1", seq: 1, event: "e1", value: 1, unit: "watts", mode: "A" }],
  { ok: false, code: "EVAL_UNIT_UNKNOWN" },
);

// EVAL-004 — non-monotonic seq rejected.
const eval004 = metricFixture(
  "EVAL-004",
  "non-monotonic sequence rejected with EVAL_ORDER_INVALID",
  [
    { session: "s1", seq: 2, event: "e2", value: 2, unit: "count", mode: "A" },
    { session: "s1", seq: 1, event: "e1", value: 1, unit: "count", mode: "A" },
  ],
  { ok: false, code: "EVAL_ORDER_INVALID" },
);

// EVAL-BUCKET-001 — 1ms and 250ms land on inclusive boundaries.
const evalBucket = metricFixture(
  "EVAL-005",
  "EVAL-BUCKET-001: values at 1ms and 250ms land on inclusive histogram boundaries",
  [
    { session: "s1", seq: 1, event: "lat", value: 1, unit: "ms", mode: "A" },
    { session: "s1", seq: 2, event: "lat", value: 250, unit: "ms", mode: "A" },
    { session: "s1", seq: 3, event: "lat", value: 250, unit: "ms", mode: "A" },
  ],
  { ok: true, histogram: [1, 0, 0, 0, 0, 0, 2, 0], overflow: 0, total: 3 },
);

// EVAL-006 — overflow past 250ms kept separate.
const eval006 = metricFixture(
  "EVAL-006",
  "latency past 250ms kept in the separate overflow bucket",
  [
    { session: "s1", seq: 1, event: "lat", value: 10, unit: "ms", mode: "A" },
    { session: "s1", seq: 2, event: "lat", value: 251, unit: "ms", mode: "A" },
    { session: "s1", seq: 3, event: "lat", value: 300, unit: "ms", mode: "A" },
  ],
  { ok: true, histogram: [0, 0, 1, 0, 0, 0, 0, 2], overflow: 2, total: 3 },
);

// EVAL-REDACT-002 — prompt bytes never appear in JSONL.
const promptText = "the quick brown fox jumps over the lazy prompt";
const evalRedactPrompt = annotationFixture(
  "EVAL-007",
  "EVAL-REDACT-002: prompt bytes never appear in redacted JSONL",
  { field: "prompt", kind: "prompt", bytesBase64: b64(promptText) },
  { ok: true, redactedCount: 1, digestHex: sha256Hex(Buffer.from(promptText, "utf8")) },
);

// EVAL-008 — payload bytes redacted.
const payloadText = "EXACT-LEDGER-PAYLOAD-8f3c";
const eval008 = annotationFixture(
  "EVAL-008",
  "payload bytes redacted to digest metadata",
  { field: "payload", kind: "payload", bytesBase64: b64(payloadText) },
  { ok: true, redactedCount: 1, digestHex: sha256Hex(Buffer.from(payloadText, "utf8")) },
);

// EVAL-009 — EVAL-ORDER-003: equal seq rows use event-name order.
const eval009 = metricFixture(
  "EVAL-009",
  "equal seq rows use event-name order (EVAL-ORDER-003)",
  [
    { session: "s1", seq: 1, event: "z", value: 3, unit: "count", mode: "A" },
    { session: "s1", seq: 1, event: "a", value: 1, unit: "count", mode: "A" },
  ],
  { ok: true, order: [["s1", 1, "a"], ["s1", 1, "z"]] },
);

// EVAL-010 — histogram totals permutation-stable.
const eval010 = metricFixture(
  "EVAL-010",
  "canonical order and histogram totals are permutation-stable",
  [
    { session: "s1", seq: 1, event: "lat", value: 5, unit: "ms", mode: "A" },
    { session: "s1", seq: 3, event: "lat", value: 25, unit: "ms", mode: "A" },
    { session: "s1", seq: 2, event: "lat", value: 5, unit: "ms", mode: "A" },
    { session: "s2", seq: 1, event: "lat", value: 100, unit: "ms", mode: "A" },
  ],
  {
    ok: true,
    order: [["s1", 1, "lat"], ["s1", 2, "lat"], ["s1", 3, "lat"], ["s2", 1, "lat"]],
    histogram: [0, 2, 0, 1, 0, 1, 0, 0],
    total: 4,
  },
);

export const fixtures = [
  eval001,
  eval002,
  eval003,
  eval004,
  evalBucket,
  eval006,
  evalRedactPrompt,
  eval008,
  eval009,
  eval010,
];
