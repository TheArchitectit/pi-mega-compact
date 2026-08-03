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

// ── Write all files canonically ─────────────────────────────────────────────

const REPLAY_DIR = join(V2, "replay");

rmSync(V2, { recursive: true, force: true });
mkdirSync(EVAL_DIR, { recursive: true });
mkdirSync(SCHEMA_DIR, { recursive: true });
mkdirSync(REPLAY_DIR, { recursive: true });

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

const manifest = {
  version: "2",
  viewer: "vector-cortex-conformance.mjs",
  producer: "vector-cortex-gen-fixtures.mjs",
  domain: "evaluation,replay",
  owner: "VC0A,VC0B",
  schemaVersion: "metric-event-v1;replay-cut-v2",
  license: "synthetic",
  fixtures: manifestRows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
};
writeFileSync(join(V2, "manifest.json"), Buffer.from(canonicalJson(manifest), "utf8"));

console.log(
  `generated ${fixtures.length} evaluation + ${replayFixtures.length} replay fixtures + ${Object.keys(schemas).length} schemas + manifest under ${relativePath()}`,
);
console.log("next: node scripts/vector-cortex-conformance.mjs --check");

function relativePath() {
  return "conformance/vector-cortex/v2";
}
