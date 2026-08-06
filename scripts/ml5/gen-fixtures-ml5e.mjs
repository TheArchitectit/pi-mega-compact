#!/usr/bin/env node
/**
 * ml5/gen-fixtures-ml5e.mjs — ML5-E nightly-retraining conformance fixtures.
 *
 * Sibling of gen-fixtures-ml5a.mjs / ml5b.mjs / ml5c.mjs / ml5d.mjs. Generates
 * the ML5-LOOP-001..004 fixtures under conformance/vector-cortex/v2/
 * nightly-retrain/ against the SHARED `schemas/ml5-fixture.schema.json` (the
 * `kind` enum is extended additively from `["ml5-train","bench-heads",
 * "runtime-choice","cortex-improve"]` to include `"nightly-retrain"` —
 * backward-compatible; the existing fixtures are untouched and still validate).
 *
 * Registers owner `ML5-E` in the v2 manifest and re-sorts to canonical form.
 * Idempotent: re-running reproduces byte-identical committed fixtures and does
 * not drift the manifest sha256s for unrelated rows.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/ml5/gen-fixtures-ml5e.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const RETRAIN_DIR = join(V2, "nightly-retrain");
const SCHEMA_REL = "schemas/ml5-fixture.schema.json";

export const producer = "scripts/ml5/gen-fixtures-ml5e.mjs";

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

// ── ML5-E nightly-retrain fixtures ──────────────────────────────────────────

const fixtures = [
  {
    id: "ML5-LOOP-001",
    kind: "nightly-retrain",
    flag: "MEGACOMPACT_ML5_E",
    new_rows: false,
    corpus_digest_unchanged: true,
    exit_code: 0,
    no_training_events: true,
    assertion: "corpus-digest no-op exits 0 without retraining: with no new redacted-tagged rows since the last run, retrain-nightly.mjs computes the unchanged corpus-digest and exits 0 without retraining or emitting training noise",
  },
  {
    id: "ML5-LOOP-002",
    kind: "nightly-retrain",
    flag: "MEGACOMPACT_ML5_E",
    new_rows: true,
    trains: true,
    bench_records: true,
    packaged_asset: true,
    manifest_append: true,
    assertion: "training-run records full pipeline on new rows: with new redacted-tagged rows, the orchestrator records a full training run (training event, bench events, packaged asset) into the append-only manifest",
  },
  {
    id: "ML5-LOOP-003",
    kind: "nightly-retrain",
    flag: "MEGACOMPACT_ML5_E",
    five_heads_ok: true,
    heldout_beat: true,
    promote: true,
    five_heads_fail: false,
    heldout_no_beat: false,
    demote: false,
    demoted_event: "demoted_new_asset",
    promotion_requires: "five_heads_ok AND heldout_beat",
    assertion: "promotion gate requires all threshold pass + held-out beat: the gate promotes only when all five heads pass their per-head thresholds AND the new asset beats the committed asset on the held-out dev set; otherwise writes the candidate and records demoted_new_asset",
  },
  {
    id: "ML5-LOOP-004",
    kind: "nightly-retrain",
    flag: "MEGACOMPACT_ML5_E",
    regression: true,
    restored_sha256: "<prior-asset-sha256>",
    atomic_swap: true,
    no_partial_state: true,
    assertion: "rollback via atomic manifest digest-swap: a regressed newly-promoted asset is atomically swapped back to the prior SHA-256 entry with no partial state — the committed pointer flips to the prior entry in one step; the append-only manifest guarantees the prior entry was never overwritten",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(RETRAIN_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rows = [];

  // Extend the shared ml5-fixture schema's `kind` enum additively so the
  // nightly-retrain envelope validates while ml5-train + bench-heads +
  // runtime-choice + cortex-improve are untouched.
  const schemaPath = join(V2, SCHEMA_REL);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const kindEnum = schema.properties?.kind?.enum;
  if (!Array.isArray(kindEnum)) throw new Error("ml5-fixture schema has no kind enum");
  if (!kindEnum.includes("nightly-retrain")) kindEnum.push("nightly-retrain");
  const schemaBytes = Buffer.from(canonicalJson(schema), "utf8");
  writeFileSync(schemaPath, schemaBytes);
  {
    const existing = manifest.fixtures.find((r) => r.path === SCHEMA_REL);
    if (existing) existing.sha256 = sha256Hex(schemaBytes);
  }

  for (const fx of fixtures) {
    const obj = { ...fx, schema: SCHEMA_REL, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `nightly-retrain/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "nightly-retrain",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const setCsv = (field, token, sep) => {
    const list = manifest[field].split(sep).map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(sep);
  };
  setCsv("owner", "ML5-E", ",");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaKind: kindEnum };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-ml5e.mjs")) {
  const { fixtureCount, schemaKind } = writeAll();
  console.log(`ml5/gen-fixtures-ml5e: wrote ${fixtureCount} fixtures, manifest updated.`);
  console.log(`ml5-fixture schema kind enum: [${schemaKind.join(", ")}]`);
}
