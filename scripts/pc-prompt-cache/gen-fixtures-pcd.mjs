#!/usr/bin/env node
/**
 * pc-prompt-cache/gen-fixtures-pcd.mjs — PC-D benchmark roll-up fixtures.
 *
 * Generates the PC-016..019 fixtures under conformance/vector-cortex/v2/
 * (prompt-cache/), updates the v2 manifest with the 4 new fixture rows + the
 * PC-D owner token, re-sorts, and rewrites the manifest — leaving every
 * pre-existing fixture file and its sha256 untouched (same id-dedupe +
 * seam-header convention as the pca/pcb/pcc siblings, and strictly additive:
 * the existing prompt-cache-fixture schema from PC-A is reused unchanged, so no
 * schema row is emitted). REGENERATION: run
 * `node scripts/pc-prompt-cache/gen-fixtures-pcd.mjs`, then commit the emitted
 * files; the committed files are authoritative.
 *
 * Each fixture is a SEMANTIC envelope pinning a PC-D roll-up contract, with
 * field names + ids matching the PC-D sprint spec's failure-triad exactly:
 *   - 016: benchmark methodology — the bench-hit-rate.mjs runner groups
 *     perf_samples by flag state (pre-pc/pc-a/pc-b via deploy-date time cutoffs)
 *     and computes valid providerCachePct ratios (cacheRead/(cacheRead+input+
 *     cacheWrite)*100) per group.
 *   - 017: --synthetic determinism — the fixed-sequence replay yields stable
 *     separated > unseparated and striped >= separated.
 *   - 018: evidence completeness — the PC-D evidence record carries measured
 *     values for all three flag states and prior PC-A/PC-B/PC-C evidence is
 *     accepted.
 *   - 019: conformance roll-up — the reserved range PC-001..019 is fully
 *     documented, all 19 fixtures registered, multi-sprint roll-up true.
 *
 * Canonical form, LOCAL-ONLY (PREVENT-PI-004), aggregation/ratios only
 * (EVAL-REDACT-002) — identical conventions to gen-fixtures-pcc.mjs.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const PROMPT_DIR = join(V2, "prompt-cache");

export const producer = "pc-prompt-cache/gen-fixtures-pcd.mjs";

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

// ── Fixtures (PC-016..019) ──────────────────────────────────────────────────

const SCHEMA_REF = "schemas/prompt-cache-fixture.schema.json";

const fixtures = [
  {
    id: "PC-016",
    assertion:
      "benchmark methodology: bench-hit-rate.mjs reads cache_hit_pct samples from the local perf_samples table, groups them by flag state (pre-pc before the PC-A deploy cutoff, pc-a before the PC-B cutoff, pc-b after) and computes valid providerCachePct ratios (cacheRead/(cacheRead+input+cacheWrite)*100) per group, printing a mean/median/p95 comparison table",
    kind: "prompt-cache",
    benchmark: "flag-state-grouping",
    groups: ["pre-pc", "pc-a", "pc-b"],
    ratios_computed: true,
    ratio_formula: "cacheRead/(cacheRead+input+cacheWrite)*100",
    grouping_source: "deploy-date time cutoffs",
  },
  {
    id: "PC-017",
    assertion:
      "synthetic replay determinism: bench-hit-rate.mjs --synthetic replays a FIXED message sequence through the stable-prefix model and produces deterministic ratios with the required improvement direction (separated > unseparated, striped >= separated)",
    kind: "prompt-cache",
    benchmark: "synthetic-replay",
    deterministic: true,
    improvement_direction: "separated>unseparated",
    striped_direction: "striped>=separated",
    llm: false,
    network: false,
  },
  {
    id: "PC-018",
    assertion:
      "evidence completeness: the PC-D evidence record contains measured providerCachePct values for all three flag states (pre-pc/pc-a/pc-b), documents the reserved fixture range, and all prior PC-A/PC-B/PC-C evidence records are accepted",
    kind: "prompt-cache",
    evidence: "PC-D",
    flag_states_measured: 3,
    all_prior_evidence_accepted: true,
    prior_evidence: ["PC-A", "PC-B", "PC-C"],
  },
  {
    id: "PC-019",
    assertion:
      "conformance roll-up: the reserved prompt-cache fixture range PC-001..019 is fully documented and all 19 fixtures are registered in the v2 manifest under the prompt-cache seam (PC-A 001-004, PC-B 005-008, PC-C 009-015, PC-D 016-019), marking the multi-sprint PC roll-up complete",
    kind: "prompt-cache",
    reserved_range: "PC-001..019",
    manifest_entries: 19,
    roll_up: true,
    owner_groups: {
      "PC-A": ["PC-001", "PC-004"],
      "PC-B": ["PC-005", "PC-008"],
      "PC-C": ["PC-009", "PC-015"],
      "PC-D": ["PC-016", "PC-019"],
    },
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(PROMPT_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  for (const fx of fixtures) {
    const obj = { ...fx, schema: SCHEMA_REF, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `prompt-cache/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: SCHEMA_REF,
      algorithm: "prompt-cache",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const setOwnerCsv = (token) => {
    const list = manifest.owner.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest.owner = list.sort().join(",");
  };
  setOwnerCsv("PC-D");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-pcd.mjs")) {
  const { fixtureCount } = writeAll();
  console.log(`pc-prompt-cache/pcd: wrote ${fixtureCount} fixtures, manifest updated.`);
}
