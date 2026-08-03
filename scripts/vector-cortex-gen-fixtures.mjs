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

// ── Write all files canonically ─────────────────────────────────────────────

rmSync(V2, { recursive: true, force: true });
mkdirSync(EVAL_DIR, { recursive: true });
mkdirSync(SCHEMA_DIR, { recursive: true });

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

const manifest = {
  version: "2",
  viewer: "vector-cortex-conformance.mjs",
  producer: "vector-cortex-gen-fixtures.mjs",
  domain: "evaluation",
  owner: "VC0A",
  schemaVersion: "metric-event-v1",
  license: "synthetic",
  fixtures: manifestRows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
};
writeFileSync(join(V2, "manifest.json"), Buffer.from(canonicalJson(manifest), "utf8"));

console.log(`generated ${fixtures.length} evaluation fixtures + ${Object.keys(schemas).length} schemas + manifest under ${relativePath()}`);
console.log("next: node scripts/vector-cortex-conformance.mjs --check");

function relativePath() {
  return "conformance/vector-cortex/v2";
}
