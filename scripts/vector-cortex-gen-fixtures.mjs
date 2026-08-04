#!/usr/bin/env node
/**
 * vector-cortex-gen-fixtures.mjs — regenerate the VC0A conformance fixtures.
 *
 * Produces every file under conformance/vector-cortex/v2/ in canonical JSON
 * form (see CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes, shortest
 * number representation, final LF, SHA-256 over the declared canonical bytes,
 * and rewrites manifest.json listing each file for the conformance checker.
 *
 * REGENERATION: run after editing fixtures; commit the emitted files. The
 * conformance --check gate verifies the committed bytes are exactly these.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 */

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const V2 = join(scriptDir, "..", "conformance", "vector-cortex", "v2");
const EVAL_DIR = join(V2, "evaluation");
const SCHEMA_DIR = join(V2, "schemas");

function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return String(value); // shortest int/number
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`).join(",")}}`;
}

function canonicalJson(value) {
  return canonicalValue(value) + "\n";
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

// ── Schema files (canonicalized by construction) ───────────────────────────

const schemas = {};

schemas["schemas/eval-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "EVAL conformance fixture envelope",
  description: "Common structure every VC0A evaluation fixture validates against.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["metric", "annotation", "schema"] },
    expected: { type: "object" },
    input: { type: ["object", "array"] },
  },
};

schemas["schemas/metric-event-v1.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "MetricEventV1",
  description: "VC0A evaluation metric sample (contract types.ts).",
  type: "object",
  required: ["session", "seq", "event", "value", "unit", "mode"],
  properties: {
    session: { type: "string" },
    seq: { type: "integer" },
    event: { type: "string" },
    value: { type: "number" },
    unit: { type: "string", enum: ["ms", "bytes", "count", "ratio"] },
    mode: { type: "string", enum: ["A", "B", "C"] },
  },
};

schemas["schemas/annotation-v1.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "AnnotationV1",
  description: "VC0A redaction metadata (contract types.ts).",
  type: "object",
  required: ["itemId", "redactions", "redactedCount"],
  properties: {
    itemId: { type: "string" },
    redactions: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "digest", "bytes", "kind"],
        properties: {
          field: { type: "string" },
          digest: { type: "string" },
          bytes: { type: "integer" },
          kind: { type: "string", enum: ["payload", "prompt", "ledger"] },
        },
      },
    },
    redactedCount: { type: "integer" },
  },
};

schemas["schemas/replay-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "ReplayCutV2 conformance fixture envelope",
  description: "Common structure every VC0B replay/migration fixture validates against.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["cut", "migration"] },
    expected: { type: "object" },
    input: { type: "object" },
  },
};

schemas["schemas/event-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "EventV2 fixture envelope",
  description:
    "Common structure every VC1A EventV2 codec (encode) / validator (validate) fixture validates against. Binary fields are unpadded-free standard base64.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["encode", "validate"] },
    expected: { type: "object" },
    input: {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["sessionId", "seq", "eventId", "role", "kind", "bytesBase64"],
            properties: {
              sessionId: { type: "string" },
              seq: { type: "integer" },
              eventId: { type: "string" },
              role: { type: "string", enum: ["policy", "user", "assistant", "tool"] },
              kind: { type: "string" },
              bytesBase64: { type: "string" },
              toolCallId: { type: "string" },
              // Optional corruption overrides used by validate-kind rows: a
              // stored bytesDigest that does not match, and/or a stored utf8
              // discriminant that contradicts the actual bytes.
              bytesDigest: { type: "string" },
              utf8Tag: { type: "string", enum: ["valid", "invalid"] },
            },
          },
        },
      },
    },
  },
};

schemas["schemas/tri-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "TRI live-safety fixture envelope",
  description:
    "Common structure every VC0C resilience fixture validates against. kind=breaker fixtures pin the breaker transition the algorithm emits (window/probe/cooldown/backoff/hysteresis/manual-halt/reset); kind=spool fixtures pin the pure-spool verdict (append/fsync/ack/idempotent/gap/conflict/torn/restart/frozen-frontier). expected.code is the exact code/verdict the implementation must return.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["breaker", "spool", "schema"] },
    expected: {
      type: "object",
      properties: {
        code: { type: "string" },
        ok: { type: "boolean" },
        state: { type: "string" },
        committedSeq: { type: "integer" },
        reason: { type: "string" },
      },
    },
    input: { type: "object" },
  },
};

// ── Evaluation fixtures EVAL-001..010 ──────────────────────────────────────

const ENV = "schemas/eval-fixture.schema.json";
const producer = "vector-cortex-gen-fixtures.mjs";

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

const fixtures = [
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

// ── Replay fixtures (VC0B) ──────────────────────────────────────────────────
// Owner VC0B: ReplayCutV2 min-of-three + pair retreat + anchor floor, and the
// M3 effective-cut-v2 copy/validate/switch migration. IDs CUT-001..020 and
// M3-001..010 (see src/vector-cortex/replay/types.ts).
// seqs are integers in the envelope; the acceptance test converts to bigint.

const REPLAY_SCHEMA = "schemas/replay-fixture.schema.json";

function cutFixture(id, assertion, input, expected) {
  return { id, schema: REPLAY_SCHEMA, producer, assertion, kind: "cut", input, expected };
}

function migrationFixture(id, assertion, input, expected) {
  return { id, schema: REPLAY_SCHEMA, producer, assertion, kind: "migration", input, expected };
}

// CUT-001 = CUT-PAIR-001: requested cut between call c7 and result r7 retreats
// before c7 (retreat to call boundary => call-1).
const cut001 = cutFixture(
  "CUT-001",
  "CUT-PAIR-001: requested cut between call c7 and result r7 retreats before c7",
  {
    requestedSeq: 8,
    boundarySafeSeq: 8,
    committedSeq: 9,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [{ callSeq: 7, resultSeq: 9 }],
  },
  { ok: true, effectiveSeq: 6, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-002 = CUT-ANCHOR-002: a pair retreat lands on the legal anchor floor and
// never crosses it; effective >= floor.
const cut002 = cutFixture(
  "CUT-002",
  "CUT-ANCHOR-002: retreat cannot cross the recent-anchor floor",
  {
    requestedSeq: 9,
    boundarySafeSeq: 9,
    committedSeq: 8,
    capturedHighWater: 7,
    anchorFloor: 5,
    pairs: [{ callSeq: 6, resultSeq: 8 }],
  },
  { ok: true, effectiveSeq: 5, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"], anchorFloorRespected: true },
);

// CUT-003 = CUT-HIGHWATER-003: captured high-water below committed seq wins.
const cut003 = cutFixture(
  "CUT-003",
  "CUT-HIGHWATER-003: captured high-water below committed seq wins",
  {
    requestedSeq: 10,
    boundarySafeSeq: 10,
    committedSeq: 9,
    capturedHighWater: 4,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: [] },
);

// CUT-004: committed is a unique min; no pair and no retreat.
const cut004 = cutFixture(
  "CUT-004",
  "committed unique min with no pairs; no retreat",
  {
    requestedSeq: 12,
    boundarySafeSeq: 12,
    committedSeq: 5,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 5, retreatCodes: [] },
);

// CUT-005: committed is the unique min; no pairs.
const cut005 = cutFixture(
  "CUT-005",
  "committed seq is the unique min; no retreat",
  {
    requestedSeq: 20,
    boundarySafeSeq: 20,
    committedSeq: 3,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 3, retreatCodes: [] },
);

// CUT-006: requestedSeq caps the cut when every source exceeds it.
const cut006 = cutFixture(
  "CUT-006",
  "requestedSeq caps the cut when every source exceeds it",
  {
    requestedSeq: 6,
    boundarySafeSeq: 30,
    committedSeq: 40,
    capturedHighWater: 50,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 6, retreatCodes: [] },
);

// CUT-007: two sources tie at the min; lower source order (committed) wins.
const cut007 = cutFixture(
  "CUT-007",
  "equal committed and captured minima; lower source order wins (CUT_LOWEST_SOURCE_ORDER)",
  {
    requestedSeq: 20,
    boundarySafeSeq: 20,
    committedSeq: 5,
    capturedHighWater: 5,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 5, retreatCodes: ["CUT_LOWEST_SOURCE_ORDER"] },
);

// CUT-008: balanced stream, contiguous cuts with no pairs (cut at even seq).
const cut008 = cutFixture(
  "CUT-008",
  "balanced contiguous stream with no pairs; cut honours the min",
  {
    requestedSeq: 100,
    boundarySafeSeq: 100,
    committedSeq: 50,
    capturedHighWater: 60,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 50, retreatCodes: [] },
);

// CUT-009: retreat across a pair to call-1 when committed is inside the pair.
const cut009 = cutFixture(
  "CUT-009",
  "committed lands inside a pair; retreats to call boundary",
  {
    requestedSeq: 16,
    boundarySafeSeq: 16,
    committedSeq: 13,
    capturedHighWater: 14,
    anchorFloor: 0,
    pairs: [{ callSeq: 12, resultSeq: 15 }],
  },
  { ok: true, effectiveSeq: 11, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-010: anchor floor is above the min; floor wins (CUT_ANCHOR_FLOOR).
const cut010 = cutFixture(
  "CUT-010",
  "anchor floor above the min cap; the cut rises to the floor",
  {
    requestedSeq: 10,
    boundarySafeSeq: 5,
    committedSeq: 3,
    capturedHighWater: 2,
    anchorFloor: 4,
    pairs: [],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: ["CUT_ANCHOR_FLOOR"] },
);

// CUT-011: pair retreat target stays above the anchor floor (no crossing).
const cut011 = cutFixture(
  "CUT-011",
  "pair retreat target lands above the anchor floor (no crossing)",
  {
    requestedSeq: 12,
    boundarySafeSeq: 12,
    committedSeq: 10,
    capturedHighWater: 9,
    anchorFloor: 5,
    pairs: [{ callSeq: 8, resultSeq: 11 }],
  },
  { ok: true, effectiveSeq: 7, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"], anchorFloorRespected: true },
);

// CUT-012: three distinct sources, boundary is smallest; boundary wins.
const cut012 = cutFixture(
  "CUT-012",
  "boundary-safe seq is the unique min; wins",
  {
    requestedSeq: 30,
    boundarySafeSeq: 2,
    committedSeq: 25,
    capturedHighWater: 28,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 2, retreatCodes: [] },
);

// CUT-013: no pairs, boundary is min, cut at boundary.
const cut013 = cutFixture(
  "CUT-013",
  "boundary-safe seq is min with no pairs; cut at it",
  {
    requestedSeq: 40,
    boundarySafeSeq: 7,
    committedSeq: 9,
    capturedHighWater: 8,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 7, retreatCodes: [] },
);

// CUT-014: multi-pair balanced stream; committed mid-window retreats past one pair.
const cut014 = cutFixture(
  "CUT-014",
  "cut inside a later pair retreats to the call boundary of that pair",
  {
    requestedSeq: 30,
    boundarySafeSeq: 30,
    committedSeq: 22,
    capturedHighWater: 24,
    anchorFloor: 0,
    pairs: [
      { callSeq: 10, resultSeq: 12 },
      { callSeq: 20, resultSeq: 25 },
    ],
  },
  { ok: true, effectiveSeq: 19, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-015: captured high-water inside a pair retreats to call boundary.
const cut015 = cutFixture(
  "CUT-015",
  "captured high-water inside a pair retreats to call boundary",
  {
    requestedSeq: 18,
    boundarySafeSeq: 18,
    committedSeq: 16,
    capturedHighWater: 14,
    anchorFloor: 0,
    pairs: [{ callSeq: 13, resultSeq: 17 }],
  },
  { ok: true, effectiveSeq: 12, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-016: requested cut inside a pair, boundary/commit/capture all above the call.
const cut016 = cutFixture(
  "CUT-016",
  "requested cut inside a pair retreats before the call",
  {
    requestedSeq: 9,
    boundarySafeSeq: 30,
    committedSeq: 30,
    capturedHighWater: 30,
    anchorFloor: 0,
    pairs: [{ callSeq: 8, resultSeq: 11 }],
  },
  { ok: true, effectiveSeq: 7, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-017: lower source order tie-break among committed+captured below boundary.
const cut017 = cutFixture(
  "CUT-017",
  "tie at committed and captured below boundary; lower source order wins",
  {
    requestedSeq: 25,
    boundarySafeSeq: 25,
    committedSeq: 6,
    capturedHighWater: 6,
    anchorFloor: 0,
    pairs: [],
  },
  { ok: true, effectiveSeq: 6, retreatCodes: ["CUT_LOWEST_SOURCE_ORDER"] },
);

// CUT-018: boundary is a legal pair-safe point and is the min; no retreat.
const cut018 = cutFixture(
  "CUT-018",
  "boundary min is pair-safe; no retreat",
  {
    requestedSeq: 15,
    boundarySafeSeq: 4,
    committedSeq: 6,
    capturedHighWater: 5,
    anchorFloor: 0,
    pairs: [{ callSeq: 5, resultSeq: 8 }],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: [] },
);

// CUT-019: committed min equal to a call seq (cut keeps call) then retreat? cut at
// call seq keeps the call; if its result is beyond, split => retreat before call.
const cut019 = cutFixture(
  "CUT-019",
  "min lands exactly on the call; pair split forces retreat before the call",
  {
    requestedSeq: 10,
    boundarySafeSeq: 10,
    committedSeq: 5,
    capturedHighWater: 9,
    anchorFloor: 0,
    pairs: [{ callSeq: 5, resultSeq: 7 }],
  },
  { ok: true, effectiveSeq: 4, retreatCodes: ["CUT_TOOL_PAIR_SPLIT"] },
);

// CUT-020: all three minima tie at a pair-safe value below requested; effective.
const cut020 = cutFixture(
  "CUT-020",
  "all three minima tie; cut at the shared pair-safe value",
  {
    requestedSeq: 20,
    boundarySafeSeq: 8,
    committedSeq: 8,
    capturedHighWater: 8,
    anchorFloor: 0,
    pairs: [{ callSeq: 3, resultSeq: 6 }],
  },
  { ok: true, effectiveSeq: 8, retreatCodes: ["CUT_LOWEST_SOURCE_ORDER"] },
);

// M3-001: full copy/validate/switch succeeds; new pointer activates.
const m3_001 = migrationFixture(
  "M3-001",
  "M3 copy/validate/switch activates the new effective cut",
  {
    host: { oldPointer: 0, stagedPointer: null, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 5, switched: true },
);

// M3-002: crash after validate, before switch retains the OLD pointer.
const m3_002 = migrationFixture(
  "M3-002",
  "M3 crash after copy/validate but before switch keeps the old pointer",
  {
    host: { oldPointer: 3, stagedPointer: 5, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 5, switched: false, retainedPointer: 3 },
);

// M3-003: resume after interrupted switch is idempotent (same result twice).
const m3_003 = migrationFixture(
  "M3-003",
  "M3 resume after interruption is idempotent",
  {
    host: { oldPointer: 1, stagedPointer: 5, active: "new" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 5, switched: true, idempotentResume: true },
);

// M3-004: invalid minima (staged effective > committed) -> M3_MINIMA_VIOLATED.
const m3_004 = migrationFixture(
  "M3-004",
  "M3 validation rejects an effective cut above a source minimum",
  {
    host: { oldPointer: 0, stagedPointer: 7, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: false, code: "M3_MINIMA_VIOLATED" },
);

// M3-005: staged pointer inside a pair -> M3_PAIR_SPLIT on validation.
const m3_005 = migrationFixture(
  "M3-005",
  "M3 validation rejects an effective cut splitting a tool pair",
  {
    host: { oldPointer: 0, stagedPointer: 4, active: "old" },
    cut: { requestedSeq: 6, boundarySafeSeq: 6, committedSeq: 4, capturedHighWater: 4, anchorFloor: 0, pairs: [{ callSeq: 3, resultSeq: 5 }] },
  },
  { ok: false, code: "M3_PAIR_SPLIT" },
);

// M3-006: staged pointer below the anchor floor -> M3_ANCHOR_CROSSED.
const m3_006 = migrationFixture(
  "M3-006",
  "M3 validation rejects an effective cut below the anchor floor",
  {
    host: { oldPointer: 0, stagedPointer: 1, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 1, capturedHighWater: 1, anchorFloor: 4, pairs: [] },
  },
  { ok: false, code: "M3_ANCHOR_CROSSED" },
);

// M3-007: staged pointer mismatch vs computed -> M3_COPY_MISMATCH.
const m3_007 = migrationFixture(
  "M3-007",
  "M3 validation rejects staged/effective mismatch (copy must not drift)",
  {
    host: { oldPointer: 0, stagedPointer: 9, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: false, code: "M3_COPY_MISMATCH", effectiveSeq: 5 },
);

// M3-008: missing host pointer -> M3_HOST_MISSING.
const m3_008 = migrationFixture(
  "M3-008",
  "M3 validation rejects a missing host pointer",
  {
    host: { oldPointer: 0, stagedPointer: null, active: "old" },
    cut: { requestedSeq: 10, boundarySafeSeq: 10, committedSeq: 5, capturedHighWater: 6, anchorFloor: 0, pairs: [] },
  },
  { ok: false, code: "M3_HOST_MISSING" },
);

// M3-009: pair retreat bounded by floor keeps migration valid on resume.
const m3_009 = migrationFixture(
  "M3-009",
  "M3 pair retreat bounded by anchor floor produces a valid resumed cut",
  {
    host: { oldPointer: 1, stagedPointer: 5, active: "old" },
    cut: { requestedSeq: 20, boundarySafeSeq: 20, committedSeq: 18, capturedHighWater: 17, anchorFloor: 5, pairs: [{ callSeq: 14, resultSeq: 19 }] },
  },
  { ok: true, effectiveSeq: 13, switched: true, anchorFloorRespected: true },
);

// M3-010: captured high-water below committed freezes the migration cut.
const m3_010 = migrationFixture(
  "M3-010",
  "M3 captures a frozen high-water below committed; high-water wins",
  {
    host: { oldPointer: 0, stagedPointer: null, active: "old" },
    cut: { requestedSeq: 30, boundarySafeSeq: 30, committedSeq: 28, capturedHighWater: 9, anchorFloor: 0, pairs: [] },
  },
  { ok: true, effectiveSeq: 9, switched: true, highWaterFrozen: true },
);

const replayFixtures = [
  cut001, cut002, cut003, cut004, cut005, cut006, cut007, cut008, cut009, cut010,
  cut011, cut012, cut013, cut014, cut015, cut016, cut017, cut018, cut019, cut020,
  m3_001, m3_002, m3_003, m3_004, m3_005, m3_006, m3_007, m3_008, m3_009, m3_010,
];

// ── EventV2 fixtures (VC1A) ─────────────────────────────────────────────────
// Owner VC1A: EventV2 byte-authority codec (A) + canonical validator + mode-B
// raw byte record. IDs EVT-001..015 (see src/vector-cortex/ledger/types.ts).
// Binary fields are standard base64 (Buffer.from(...).toString("base64")); the
// acceptance test decodes them and runs the codec/validator over the real bytes.

const EVENT_SCHEMA = "schemas/event-fixture.schema.json";

function b64bytes(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Build an encode-kind event fixture: bytes are round-tripped through the codec.
 * kind "encode": codec.encode(bytes) — the acceptance test asserts the returned
 * bytes digest exactly match, strict UTF-8 classification is as expected, and
 * decode(encode(...)).originalBytes === input bytes.
 */
function encodeFixture(id, assertion, events, expected) {
  return { id, schema: EVENT_SCHEMA, producer, assertion, kind: "encode", input: { events }, expected };
}

/**
 * Build a validate-kind event fixture: events are assembled into stored EventV2
 * (honoring optional bytesDigest/utf8Tag corruption overrides) and passed to the
 * canonical validator.
 */
function validateFixture(id, assertion, events, expected) {
  return {
    id,
    schema: EVENT_SCHEMA,
    producer,
    assertion,
    kind: "validate",
    input: { events },
    expected,
  };
}

/** Minimal envelope for a single occurrence. */
function ev(over) {
  return Object.assign(
    {
      sessionId: "s1",
      seq: 1,
      eventId: "e1",
      role: "user",
      kind: "message",
      bytesBase64: b64bytes(new TextEncoder().encode("hi")),
      occurredAtMs: 0,
    },
    over || {},
  );
}

// EVT-001 = EVT-UTF8-001: invalid sequence `ff fe` round-trips byte-for-byte,
// classifies as {valid:false, base64}, never lossy-replaced.
const evt001 = encodeFixture(
  "EVT-001",
  "EVT-UTF8-001: invalid sequence ff fe round-trips byte-for-byte (no replacement)",
  [ev({ sessionId: "s-utf8", seq: 1, eventId: "fffe", bytesBase64: b64bytes(new Uint8Array([0xff, 0xfe])) })],
  { ok: true, utf8Valid: false },
);

// EVT-002 = EVT-NFC-002: composed and decomposed e-acute remain distinct
// identities (distinct digests) but share the derived canonicalNfc.
const eComposed = new TextEncoder().encode("é"); // C3 A9
const eDecomposed = new TextEncoder().encode("é"); // 65 CC 81
const evt002 = encodeFixture(
  "EVT-002",
  "EVT-NFC-002: composed and decomposed e-acute remain distinct identities (distinct digests, equal canonical NFC)",
  [
    ev({ sessionId: "s-nfc", seq: 1, eventId: "nfc-b", bytesBase64: b64(eComposed) }),
    ev({ sessionId: "s-nfc", seq: 2, eventId: "nfc-a", bytesBase64: b64(eDecomposed) }),
  ],
  { ok: true, utf8Valid: true, distinctDigests: true, equalNfc: true, canonicalNfc: "é" },
);

// EVT-003 = EVT-TIE-003: equal session/seq sorts unsigned eventId BYTES. The
// eventIds include a non-BMP char (U+10000) whose UTF-8 first byte (F0) sorts
// AFTER U+E000 (EE) even though its JS code unit (surrogate D800) is LOWER — so
// bytewise order differs from code-unit order. A(41) < U+E000(EE) < U+10000(F0).
const tieA = new TextEncoder().encode("A");
const tieB = new TextEncoder().encode(String.fromCodePoint(0xe000));
const tieC = new TextEncoder().encode(String.fromCodePoint(0x10000));
const evt003 = validateFixture(
  "EVT-003",
  "EVT-TIE-003: equal session/seq sorts unsigned eventId bytes (code-unit vs byte divergence)",
  [
    ev({ sessionId: "s-tie", seq: 1, eventId: String.fromCodePoint(0xe000), bytesBase64: b64(tieB) }),
    ev({ sessionId: "s-tie", seq: 1, eventId: "A", bytesBase64: b64(tieA) }),
    ev({ sessionId: "s-tie", seq: 1, eventId: String.fromCodePoint(0x10000), bytesBase64: b64(tieC) }),
  ],
  { ok: true, order: ["A", String.fromCodePoint(0xe000), String.fromCodePoint(0x10000)] },
);

// EVT-004: plain ASCII round-trips as valid UTF-8.
const evt004 = encodeFixture(
  "EVT-004",
  "valid ASCII round-trips byte-for-byte with text + canonical NFC",
  [ev({ sessionId: "s-ascii", seq: 1, eventId: "hl", bytesBase64: b64bytes(new TextEncoder().encode("hello world")) })],
  { ok: true, utf8Valid: true, canonicalNfc: "hello world" },
);

// EVT-005: multi-byte UTF-8 with a composable base — NFC is derived, never identity.
const evt005 = encodeFixture(
  "EVT-005",
  "multi-byte UTF-8 (café composed) decodes and derives canonical NFC",
  [ev({ sessionId: "s-mb", seq: 1, eventId: "cafe", bytesBase64: b64bytes(new TextEncoder().encode("café")) })],
  { ok: true, utf8Valid: true, canonicalNfc: "café" },
);

// EVT-006: overlong invalid sequence C0 AF round-trips as invalid base64.
const evt006 = encodeFixture(
  "EVT-006",
  "overlong sequence c0 af classifies invalid and round-trips byte-for-byte",
  [ev({ sessionId: "s-inv2", seq: 1, eventId: "c0af", bytesBase64: b64bytes(new Uint8Array([0xc0, 0xaf])) })],
  { ok: true, utf8Valid: false },
);

// EVT-007: empty bytes are valid UTF-8 with empty text.
const evt007 = encodeFixture(
  "EVT-007",
  "empty byte array is valid UTF-8 with empty text and NFC",
  [ev({ sessionId: "s-empty", seq: 1, eventId: "empty", bytesBase64: b64bytes(new Uint8Array(0)) })],
  { ok: true, utf8Valid: true, canonicalNfc: "" },
);

// EVT-008: a UTF-8 BOM (EF BB BF) is valid; the strict decoder strips the leading
// BOM (encoding marker, not content) from the derived text/NFC — never from the
// authoritative originalBytes, which still round-trip byte-for-byte.
const evt008 = encodeFixture(
  "EVT-008",
  "UTF-8 BOM bytes decode strictly (BOM stripped from derived NFC, bytes round-trip)",
  [ev({ sessionId: "s-bom", seq: 1, eventId: "bom", bytesBase64: b64bytes(new TextEncoder().encode("﻿hello")) })],
  { ok: true, utf8Valid: true, canonicalNfc: "hello" },
);

// EVT-009: validate — stored digest does not match recomputed sha256(originalBytes).
// This is the unique failure injection: a stored byte SHA-256 retained against
// changed originalBytes -> EVT_DIGEST_MISMATCH (no replacement text anywhere).
const evt009 = validateFixture(
  "EVT-009",
  "stored digest mismatch -> EVT_DIGEST_MISMATCH (no replacement text)",
  [
    ev({
      sessionId: "s-dm",
      seq: 1,
      eventId: "d1",
      bytesBase64: b64bytes(new TextEncoder().encode("payload bytes")),
      bytesDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
  ],
  { ok: false, codes: ["EVT_DIGEST_MISMATCH"] },
);

// EVT-010: validate — stored utf8 discriminant contradicts the actual (valid) bytes.
const evt010 = validateFixture(
  "EVT-010",
  "stored utf8 tag invalid but bytes are valid UTF-8 -> EVT_UTF8_TAG_INVALID",
  [
    ev({
      sessionId: "s-utf8t",
      seq: 1,
      eventId: "t1",
      bytesBase64: b64bytes(new TextEncoder().encode("plain ascii")),
      utf8Tag: "invalid",
    }),
  ],
  { ok: false, codes: ["EVT_UTF8_TAG_INVALID"] },
);

// EVT-011: validate — duplicate (sessionId, seq, eventId) occurrence.
const evt011 = validateFixture(
  "EVT-011",
  "duplicate (sessionId, seq, eventId) -> EVT_DUPLICATE_ID",
  [
    ev({ sessionId: "s-dup", seq: 1, eventId: "dup", bytesBase64: b64bytes(new TextEncoder().encode("first")) }),
    ev({ sessionId: "s-dup", seq: 1, eventId: "dup", bytesBase64: b64bytes(new TextEncoder().encode("first")) }),
  ],
  { ok: false, codes: ["EVT_DUPLICATE_ID"] },
);

// EVT-012: validate — mixed failures surface in deterministic priority order
// (digest first, then duplicate).
const evt012 = validateFixture(
  "EVT-012",
  "digest mismatch + duplicate surfacing in deterministic priority order",
  [
    ev({
      sessionId: "s-mix",
      seq: 1,
      eventId: "m1",
      bytesBase64: b64bytes(new TextEncoder().encode("ok")),
      bytesDigest: "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    }),
    ev({ sessionId: "s-mix", seq: 2, eventId: "m2", bytesBase64: b64bytes(new TextEncoder().encode("dup")) }),
    ev({
      sessionId: "s-mix",
      seq: 2,
      eventId: "m2",
      bytesBase64: b64bytes(new TextEncoder().encode("dup")),
    }),
  ],
  { ok: false, codes: ["EVT_DIGEST_MISMATCH", "EVT_DUPLICATE_ID"] },
);

// EVT-013: validate — canonical (session, seq) ordering across sessions is ok.
const evt013 = validateFixture(
  "EVT-013",
  "canonical (session, seq) ordering across sessions",
  [
    ev({ sessionId: "s2", seq: 1, eventId: "s2-1", bytesBase64: b64bytes(new TextEncoder().encode("s2 first")) }),
    ev({ sessionId: "s1", seq: 2, eventId: "s1-2", bytesBase64: b64bytes(new TextEncoder().encode("s1 second")) }),
    ev({ sessionId: "s1", seq: 1, eventId: "s1-1", bytesBase64: b64bytes(new TextEncoder().encode("s1 first")) }),
  ],
  { ok: true, order: ["s1-1", "s1-2", "s2-1"] },
);

// EVT-014: validate — a stored byte is flipped to an INVALID UTF-8 sequence
// (ff 00) while the ORIGINAL VALID message's SHA-256 is retained -> the stored
// digest no longer matches the stored bytes (EVT_DIGEST_MISMATCH) AND the bytes
// are no longer valid while the tag still claims valid (EVT_UTF8_TAG_INVALID).
const evt014Origin = new TextEncoder().encode("aa"); // valid message whose digest is retained
const evt014 = validateFixture(
  "EVT-014",
  "flip one byte to invalid UTF-8 while retaining the original digest -> digest mismatch + utf8 tag invalid",
  [
    ev({
      sessionId: "s-flip",
      seq: 1,
      eventId: "f1",
      // stored bytes are the FLIPPED (invalid) variant of a valid message.
      bytesBase64: b64bytes(new Uint8Array([0xff, 0x00])),
      // retained digest of the ORIGINAL valid "aa" message.
      bytesDigest: "sha256:" + sha256Hex(evt014Origin),
      utf8Tag: "valid",
    }),
  ],
  { ok: false, codes: ["EVT_DIGEST_MISMATCH", "EVT_UTF8_TAG_INVALID"] },
);

// EVT-015: validate — a tool RESULT references exactly one earlier CALL in the
// same session; valid ordering with a toolCallId round-trips ok.
const evt015 = validateFixture(
  "EVT-015",
  "tool call/result pair in a session is valid and ordered by (seq, eventId)",
  [
    ev({ sessionId: "s-tool", seq: 1, eventId: "call", role: "assistant", kind: "tool_call", toolCallId: "tc1", bytesBase64: b64bytes(new TextEncoder().encode("call")) }),
    ev({ sessionId: "s-tool", seq: 2, eventId: "res", role: "tool", kind: "tool_result", toolCallId: "tc1", bytesBase64: b64bytes(new TextEncoder().encode("result")) }),
    ev({ sessionId: "s-tool", seq: 3, eventId: "tail", bytesBase64: b64bytes(new TextEncoder().encode("tail")) }),
  ],
  { ok: true, order: ["call", "res", "tail"] },
);

const eventFixtures = [
  evt001, evt002, evt003, evt004, evt005, evt006, evt007, evt008,
  evt009, evt010, evt011, evt012, evt013, evt014, evt015,
];

// ── Resilience fixtures (VC0C): TRI-001..030 + named WINDOW/PROBE/FREEZE ──
// Owner VC0C (TRIAD_RESILIENCE). kind=breaker rows pin the breaker state
// machine transition/code; kind=spool rows pin the pure-spool verdict. Each
// fixture's `expected.code` is the exact code/verdict the implementation must
// return for the described scenario — the acceptance test re-executes the real
// breaker/spool and asserts parity. TRI-001..015 are breaker transitions;
// TRI-016..030 are spool protocol rows. The three named fixtures
// (TRI-WINDOW-001, TRI-PROBE-002, TRI-FREEZE-003) are the headline acceptance
// cases the conformance section calls out explicitly.
const TRI = "schemas/tri-fixture.schema.json";

function tri(id, kind, assertion, expected, input) {
  return { id, producer, schema: TRI, kind, assertion, expected, input: input ?? {} };
}

const resilienceFixtures = [
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
const windowFixture = tri(
  "TRI-WINDOW-001",
  "breaker",
  "TRI-WINDOW-001: twentieth failed attempt inside the 60s window opens the breaker (OPEN_B).",
  { code: "TRI_OPEN_B", state: "OPEN_B" },
  { scenario: "the 20th A-failure, all within 60s, trips CLOSED_A -> OPEN_B" },
);
const probeFixture = tri(
  "TRI-PROBE-002",
  "breaker",
  "TRI-PROBE-002: three successful probes (after cooldown + healthy residence) enter CLOSED_A.",
  { code: "OK", state: "CLOSED_A" },
  { scenario: "cooldown waits, 5min healthy residence, then exactly 3 probes promote" },
);
const freezeFixture = tri(
  "TRI-FREEZE-003",
  "spool",
  "TRI-FREEZE-003: authority outage preserves the prior frontier (high-water freezes while frames append).",
  { code: "FRONTIER_FROZEN" },
  { session: "sp-freeze-003", outage: true, ops: [{ op: "append", seq: 1, eventId: "e1" }, { op: "assertFrozen" }] },
);

const resilienceNamed = [windowFixture, probeFixture, freezeFixture];

// ── Write all files canonically ─────────────────────────────────────────────

const REPLAY_DIR = join(V2, "replay");
const EVENTS_DIR = join(V2, "events");
const RESILIENCE_DIR = join(V2, "resilience");

rmSync(V2, { recursive: true, force: true });
mkdirSync(EVAL_DIR, { recursive: true });
mkdirSync(SCHEMA_DIR, { recursive: true });
mkdirSync(REPLAY_DIR, { recursive: true });
mkdirSync(EVENTS_DIR, { recursive: true });
mkdirSync(RESILIENCE_DIR, { recursive: true });

const manifestRows = [];

for (const [rel, obj] of Object.entries(schemas)) {
  const bytes = Buffer.from(canonicalJson(obj), "utf8");
  writeFileSync(join(V2, rel), bytes);
  manifestRows.push({
    id: rel.split("/").pop().replace(".schema.json", ""),
    path: rel,
    sha256: sha256Hex(bytes),
    schema: rel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });
}

for (const fx of fixtures) {
  const bytes = Buffer.from(canonicalJson(fx), "utf8");
  const rel = `evaluation/${fx.id}.json`;
  writeFileSync(join(EVAL_DIR, `${fx.id}.json`), bytes);
  manifestRows.push({
    id: fx.id,
    path: rel,
    sha256: sha256Hex(bytes),
    schema: fx.schema,
    algorithm: fx.kind === "metric" ? "metric-event-v1" : "annotation-v1",
    producer,
    expected: fx.expected.ok ? "ok" : fx.expected.code,
    license: "synthetic",
  });
}

for (const fx of replayFixtures) {
  const bytes = Buffer.from(canonicalJson(fx), "utf8");
  const rel = `replay/${fx.id}.json`;
  writeFileSync(join(REPLAY_DIR, `${fx.id}.json`), bytes);
  manifestRows.push({
    id: fx.id,
    path: rel,
    sha256: sha256Hex(bytes),
    schema: fx.schema,
    algorithm: fx.kind === "cut" ? "replay-cut-v2" : "effective-cut-v2",
    producer,
    expected: fx.expected.ok ? "ok" : fx.expected.code,
    license: "synthetic",
  });
}

// EventV2 fixtures (VC1A): algorithm "event-v2" for encode rows (codec byte
// authority) and "event-v2-validate" for validator rows.
for (const fx of eventFixtures) {
  const bytes = Buffer.from(canonicalJson(fx), "utf8");
  const rel = `events/${fx.id}.json`;
  writeFileSync(join(EVENTS_DIR, `${fx.id}.json`), bytes);
  // A validate-kind failure row's expected code is the FIRST listed code.
  const failureCode = !fx.expected.ok && Array.isArray(fx.expected.codes)
    ? fx.expected.codes[0]
    : null;
  manifestRows.push({
    id: fx.id,
    path: rel,
    sha256: sha256Hex(bytes),
    schema: fx.schema,
    algorithm: fx.kind === "encode" ? "event-v2" : "event-v2-validate",
    producer,
    expected: fx.expected.ok ? "ok" : failureCode,
    license: "synthetic",
  });
}

// Resilience fixtures (VC0C): kind=breaker -> "tri-breaker", kind=spool ->
// "tri-spool". expected.code is the code/verdict the implementation returns.
for (const fx of resilienceFixtures) {
  const bytes = Buffer.from(canonicalJson(fx), "utf8");
  const rel = `resilience/${fx.id}.json`;
  writeFileSync(join(RESILIENCE_DIR, `${fx.id}.json`), bytes);
  manifestRows.push({
    id: fx.id,
    path: rel,
    sha256: sha256Hex(bytes),
    schema: fx.schema,
    algorithm: fx.kind === "breaker" ? "tri-breaker" : "tri-spool",
    producer,
    expected: fx.expected.code,
    license: "synthetic",
  });
}
for (const fx of resilienceNamed) {
  const bytes = Buffer.from(canonicalJson(fx), "utf8");
  const rel = `resilience/${fx.id}.json`;
  writeFileSync(join(RESILIENCE_DIR, `${fx.id}.json`), bytes);
  manifestRows.push({
    id: fx.id,
    path: rel,
    sha256: sha256Hex(bytes),
    schema: fx.schema,
    algorithm: fx.kind === "breaker" ? "tri-breaker" : "tri-spool",
    producer,
    expected: fx.expected.code,
    license: "synthetic",
  });
}

const manifest = {
  version: "2",
  viewer: "vector-cortex-conformance.mjs",
  producer: "vector-cortex-gen-fixtures.mjs",
  domain: "evaluation,replay,events,resilience",
  owner: "VC0A,VC0B,VC1A,VC0C",
  schemaVersion: "metric-event-v1;replay-cut-v2;event-v2;tri-fixture",
  license: "synthetic",
  fixtures: manifestRows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
};
writeFileSync(join(V2, "manifest.json"), Buffer.from(canonicalJson(manifest), "utf8"));

console.log(
  `generated ${fixtures.length} evaluation + ${replayFixtures.length} replay + ${eventFixtures.length} event fixtures + ${resilienceFixtures.length} resilience + ${resilienceNamed.length} named resilience fixtures + ${Object.keys(schemas).length} schemas + manifest under ${relativePath()}`,
);
console.log("next: node scripts/vector-cortex-conformance.mjs --check");

function relativePath() {
  return "conformance/vector-cortex/v2";
}
