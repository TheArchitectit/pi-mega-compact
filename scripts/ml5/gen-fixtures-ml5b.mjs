#!/usr/bin/env node
/**
 * ml5/gen-fixtures-ml5b.mjs — ML5-B production bench-heads fixtures.
 *
 * Sibling of gen-fixtures-ml5a.mjs (ML5-A). Generates the ML5-BENCH-001..004
 * fixtures under conformance/vector-cortex/v2/bench-heads/, reusing the shared
 * `schemas/ml5-fixture.schema.json` from ML5-A, and registers them + owner
 * `ML5-B` in the v2 manifest (idempotent, canonical sorted-keys LF-final).
 *
 * The shared ml5-fixture schema is REUSED, but its `kind` enum is additively
 * extended from `["ml5-train"]` to `["ml5-train","bench-heads"]` so the ML5-B
 * `kind:"bench-heads"` envelope validates against it (CONFORMANCE.md enforces
 * the enum). This is backward-compatible: ML5-A's six `ml5-train` fixtures are
 * untouched and still validate. The schema's manifest sha256 is re-registered
 * to match the broadened bytes.
 *
 * Each fixture pins one SEMANTIC gate contract (verified by
 * ml5b-acceptance.test.ts):
 *   - 001: p95 latency pass/fail at 512 tokens on 4 threads (<= 40 ms).
 *   - 002: steady-state marginal RSS pass/fail over the process baseline
 *     (<= 150 MiB, baseline-subtracted).
 *   - 003: opset-17 handshake assertion (opset_import declares 17, ok).
 *   - 004: determinism + end-to-end integration pin (3 runs, 1 distinct digest,
 *     4 events written, corpus->bench->events->BenchResultV1).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes.
 *
 * REGENERATION: run `node scripts/ml5/gen-fixtures-ml5b.mjs`, then commit the
 * emitted files. The committed files are authoritative.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const BENCH_DIR = join(V2, "bench-heads");
const SCHEMA_REL = "schemas/ml5-fixture.schema.json";

export const producer = "scripts/ml5/gen-fixtures-ml5b.mjs";

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

// ── ML5-B bench-heads fixtures (ML5-BENCH-001..004) ─────────────────────────

const fixtures = [
  {
    id: "ML5-BENCH-001",
    assertion: "p95 latency pass/fail at 512 tokens on 4 threads (budget 40 ms: p95 <= 40)",
    kind: "bench-heads",
    flag: "MEGACOMPACT_ML5_B",
    gate: "latency",
    tokens: 512,
    threads: 4,
    budget_ms: 40,
  },
  {
    id: "ML5-BENCH-002",
    assertion: "steady-state marginal RSS pass/fail over the process baseline (budget 150 MiB: marginal <= 150, baseline-subtracted)",
    kind: "bench-heads",
    flag: "MEGACOMPACT_ML5_B",
    gate: "rss",
    budget_mib: 150,
    baseline_subtracted: true,
  },
  {
    id: "ML5-BENCH-003",
    assertion: "opset-17 handshake assertion (the loaded model's opset_import declares 17, handshake ok)",
    kind: "bench-heads",
    flag: "MEGACOMPACT_ML5_B",
    gate: "opset",
    opset: 17,
    handshake: "ok",
  },
  {
    id: "ML5-BENCH-004",
    assertion: "determinism + end-to-end integration pin: identical SHA-256 across 3 runs (1 distinct digest) and all four vector_cortex_encoder_bench_* events written (corpus->bench->events->BenchResultV1)",
    kind: "bench-heads",
    flag: "MEGACOMPACT_ML5_B",
    gate: "determinism",
    runs: 3,
    distinct_digests: 1,
    events_written: 4,
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(BENCH_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rows = [];

  // Extend the shared ml5-fixture schema's `kind` enum additively so `bench-heads`
  // validates while `ml5-train` (ML5-A) is untouched. Re-register its sha256.
  const schemaPath = join(V2, SCHEMA_REL);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const kindEnum = schema.properties?.kind?.enum;
  if (!Array.isArray(kindEnum)) throw new Error("ml5-fixture schema has no kind enum");
  if (!kindEnum.includes("bench-heads")) kindEnum.push("bench-heads");
  const schemaBytes = Buffer.from(canonicalJson(schema), "utf8");
  writeFileSync(schemaPath, schemaBytes);
  {
    const existing = manifest.fixtures.find((r) => r.path === SCHEMA_REL);
    if (existing) existing.sha256 = sha256Hex(schemaBytes);
    else rows.push({
      id: "ml5-fixture", path: SCHEMA_REL, sha256: sha256Hex(schemaBytes),
      schema: SCHEMA_REL, algorithm: "json-schema", producer, expected: "schema", license: "synthetic",
    });
  }

  for (const fx of fixtures) {
    const obj = { ...fx, schema: SCHEMA_REL, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `bench-heads/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "bench-heads",
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
  setCsv("owner", "ML5-B", ",");
  // schemaVersion already carries ml5-fixture (ML5-A); ensure it is present.

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaKind: kindEnum };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-ml5b.mjs")) {
  const { fixtureCount, schemaKind } = writeAll();
  console.log(`ml5/gen-fixtures-ml5b: wrote ${fixtureCount} fixtures, manifest updated.`);
  console.log(`ml5-fixture schema kind enum: [${schemaKind.join(", ")}]`);
}
