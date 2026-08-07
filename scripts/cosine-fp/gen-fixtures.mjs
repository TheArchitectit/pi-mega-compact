// guardrails-allow PREVENT-PI-004: local-only conformance fixture generator — pure fs write, no network.
/**
 * scripts/cosine-fp/gen-fixtures.mjs — COS-FP-A conformance fixtures.
 *
 * Generates the COS-FP-A-001..005 fixtures + the cosfp-fixture schema under
 * conformance/vector-cortex/v2/ (cosine-fp/ + schemas/) and appends their rows
 * to the v2 manifest (owner COS-FP-A). Reads the existing manifest, appends
 * its rows, re-sorts, and rewrites — leaving every pre-existing fixture file
 * and its sha256 untouched (same id-dedupe + seam-header convention as the
 * dedup-attr generator).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. Regeneration is idempotent.
 *
 * The pinned report digest below is the deterministic SHA-256 of the committed
 * bench-run aggregate (seed 20260806) — COS-FP-A-002 pins that same seed +
 * params yields a byte-identical digest across runs.
 *
 * REGENERATION: run `node scripts/cosine-fp/gen-fixtures.mjs`, then commit the
 * emitted files. The committed files are authoritative.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const COSFP_DIR = join(V2, "cosine-fp");
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "scripts/cosine-fp/gen-fixtures.mjs";

// Deterministic report digest for seed 20260806 (pinned in COS-FP-A-002).
export const PINNED_REPORT_DIGEST =
  "2312c120c43c75ff46db9fc8f362c25df879a54862790d8d2cbac2e88466d646";

export function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return String(value);
    if (typeof value === "number") return String(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`).join(",")}}`;
}

export function canonicalJson(value) {
  return canonicalValue(value) + "\n";
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ── COS-FP-A fixture schema ─────────────────────────────────────────────────

const COSFP_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "COS-FP-A synthetic FP harness + L2 cosine threshold calibration fixture envelope",
  type: "object",
  description:
    "Common structure every COS-FP-A fixture validates against. `assertion` names the synthetic-harness property; `kind` pins the algorithm to cosfp. Per-fixture pins: COS-FP-A-001 carries the content-type + grid stratification; COS-FP-A-002 pins digest determinism; COS-FP-A-003 pins the no-fabrication fallback; COS-FP-A-004 pins the exact < vs >= off-by-one threshold boundary; COS-FP-A-005 pins flag-off byte-identity.",
  required: ["id", "producer", "assertion", "kind", "schema"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    schema: { type: "string" },
    kind: { type: "string", enum: ["cosfp"] },
    flag: { type: "string" },
    flag_enabled: { type: "boolean" },
    content_types: {
      type: "array",
      items: { type: "string", enum: ["code", "prose", "mixed"] },
    },
    grid: {
      type: "object",
      properties: {
        lo: { type: "number" },
        hi: { type: "number" },
        step: { type: "number" },
        points: { type: "integer" },
      },
    },
    per_type_fp_fractions: {
      type: "array",
      items: { type: "number", minimum: 0, maximum: 1 },
    },
    status: { type: "string", enum: ["ok", "no_data"] },
    seed_invariant: { type: "boolean" },
    report_digest_sha256: { type: "string" },
    same_corpus_same_digest: { type: "boolean" },
    no_data: { type: "string" },
    fabricated_threshold: { type: "boolean" },
    fabricated_fp: { type: "boolean" },
    strict_straddle: { type: "boolean" },
    boundary: {
      type: "object",
      properties: { lo: { type: "number" }, hi: { type: "number" } },
    },
    l2_cosine: { type: "string" },
    override_enabled: { type: "boolean" },
    byte_identical: { type: "boolean" },
  },
};

// ── Fixtures (COS-FP-A-001..005) ────────────────────────────────────────────

const fixtures = [
  {
    id: "COS-FP-A-001",
    assertion:
      "stratified report correctness — the bench sweep covers all three content types (code/prose/mixed) across the 37-point grid 0.80→0.98 step 0.005 and reports real per-type FP fractions in [0,1] with status ok",
    kind: "cosfp",
    flag: "MEGACOMPACT_COSINE_FP_BENCH",
    flag_enabled: true,
    content_types: ["code", "prose", "mixed"],
    grid: { lo: 0.8, hi: 0.98, step: 0.005, points: 37 },
    per_type_fp_fractions: [0, 1],
    status: "ok",
  },
  {
    id: "COS-FP-A-002",
    assertion:
      "determinism — same seed + same params yield a byte-identical report digest SHA-256 across two identical runs",
    kind: "cosfp",
    seed_invariant: true,
    report_digest_sha256: PINNED_REPORT_DIGEST,
    same_corpus_same_digest: true,
  },
  {
    id: "COS-FP-A-003",
    assertion:
      "no-fabrication fallback — a collapsed/empty corpus reports an explicit status no_data and never fabricates a threshold or fakes FP=0",
    kind: "cosfp",
    no_data: "explicit",
    status: "no_data",
    fabricated_threshold: false,
    fabricated_fp: false,
  },
  {
    id: "COS-FP-A-004",
    assertion:
      "off-by-one threshold boundary — a pair at cosine 0.8995 is passed at threshold 0.900 and deduped at 0.899 (exact < vs >= semantics), never both",
    kind: "cosfp",
    boundary: { lo: 0.899, hi: 0.9 },
    strict_straddle: true,
  },
  {
    id: "COS-FP-A-005",
    assertion:
      "flag-off byte-identical — MEGACOMPACT_COSINE_FP_BENCH=0 leaves L2_COSINE as plain MEGACOMPACT_L2_THRESHOLD=0.85 with overrides disabled, byte-identical to the predecessor",
    kind: "cosfp",
    flag_enabled: false,
    l2_cosine: "MEGACOMPACT_L2_THRESHOLD=0.85",
    override_enabled: false,
    byte_identical: true,
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(COSFP_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(COSFP_SCHEMA), "utf8");
  const schemaRel = "schemas/cosfp-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "cosfp-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = {
      ...fx,
      schema: "schemas/cosfp-fixture.schema.json",
      producer,
    };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `cosine-fp/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "cosfp",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const setCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setCsv("domain", "cosine-fp");
  setCsv("owner", "COS-FP-A");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(
    `cosine-fp: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`,
  );
}
