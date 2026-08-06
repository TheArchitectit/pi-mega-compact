#!/usr/bin/env node
/**
 * ml5/gen-fixtures-ml5d.mjs — ML5-D dashboard "Improve Cortex" conformance fixtures.
 *
 * Sibling of gen-fixtures-ml5a.mjs / gen-fixtures-ml5b.mjs / gen-fixtures-ml5c.mjs.
 * Generates the ML5-DASH-001..006 fixtures under conformance/vector-cortex/v2/
 * cortex-improve/ against the SHARED `schemas/ml5-fixture.schema.json` (the `kind`
 * enum is extended additively from `["ml5-train","bench-heads","runtime-choice"]`
 * to include `"cortex-improve"` — backward-compatible; the existing fixtures are
 * untouched and still validate).
 *
 * Registers owner `ML5-D` in the v2 manifest and re-sorts to canonical form.
 * Idempotent: re-running reproduces byte-identical committed fixtures and does
 * not drift the manifest sha256s for unrelated rows.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/ml5/gen-fixtures-ml5d.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const DASH_DIR = join(V2, "cortex-improve");
const SCHEMA_REL = "schemas/ml5-fixture.schema.json";

export const producer = "scripts/ml5/gen-fixtures-ml5d.mjs";

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

// ── ML5-D Improve-Cortex fixtures ────────────────────────────────────────────

const fixtures = [
  {
    id: "ML5-DASH-001",
    kind: "cortex-improve",
    flag: "MEGACOMPACT_ML5_D",
    mode: "A",
    render: "promoted",
    badge: "Promoted",
    endpoint: "/api/cortex/improve",
    assertion: "card render — qualified mode-A asset makes the ModelImprovementCard render the Promoted state with mode A, last bench, verdict, and a terminal-qualified badge",
  },
  {
    id: "ML5-DASH-002",
    kind: "cortex-improve",
    flag: "MEGACOMPACT_ML5_D",
    mode: "B",
    render: "rejected",
    badge: "Rejected",
    reason_field: true,
    assertion: "card render — unqualified mode-B asset renders the Rejected / demoted_to_B state with the demotion reason surfaced",
  },
  {
    id: "ML5-DASH-003",
    kind: "cortex-improve",
    flag: "MEGACOMPACT_ML5_D",
    flag_enabled: false,
    endpoints_status: 404,
    card_present: false,
    assertion: "flag-off byte-identity — MEGACOMPACT_ML5_D=0 makes both improve endpoints return 404 and VectorCortexTab omit the ModelImprovementCard, byte-identical to the ML5-C-era tab",
  },
  {
    id: "ML5-DASH-004",
    kind: "cortex-improve",
    flag: "MEGACOMPACT_ML5_D",
    confirm_required: true,
    action: "POST /api/cortex/improve",
    returns: "{status:improving, jobId}",
    assertion: "improve trigger — requires the window.confirm confirmation server-side (confirm:true) and returns an opaque jobId",
  },
  {
    id: "ML5-DASH-005",
    kind: "cortex-improve",
    flag: "MEGACOMPACT_ML5_D",
    progress_states: ["improving", "qualified", "demoted_to_B"],
    terminal_qualified: { status: "qualified", verdict: true },
    terminal_demoted: { status: "demoted_to_B", reason: true },
    assertion: "status endpoint — the job walks progressing -> terminal qualified / demoted_to_B; the terminal qualified body carries a verdict and the demoted body carries a reason",
  },
  {
    id: "ML5-DASH-006",
    kind: "cortex-improve",
    flag: "MEGACOMPACT_ML5_D",
    transition: "mode->improving->qualified|demoted_to_B",
    badge_transition_pinned: true,
    assertion: "mode-badge state-transition pin — the card transitions Idle -> Improving -> Promoted / Rejected and the badge flip is pinned end-to-end",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(DASH_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rows = [];

  // Extend the shared ml5-fixture schema's `kind` enum additively so the
  // cortex-improve envelope validates while ml5-train + bench-heads +
  // runtime-choice are untouched.
  const schemaPath = join(V2, SCHEMA_REL);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const kindEnum = schema.properties?.kind?.enum;
  if (!Array.isArray(kindEnum)) throw new Error("ml5-fixture schema has no kind enum");
  if (!kindEnum.includes("cortex-improve")) kindEnum.push("cortex-improve");
  const schemaBytes = Buffer.from(canonicalJson(schema), "utf8");
  writeFileSync(schemaPath, schemaBytes);
  {
    const existing = manifest.fixtures.find((r) => r.path === SCHEMA_REL);
    if (existing) existing.sha256 = sha256Hex(schemaBytes);
  }

  for (const fx of fixtures) {
    const obj = { ...fx, schema: SCHEMA_REL, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `cortex-improve/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "cortex-improve",
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
  setCsv("owner", "ML5-D", ",");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaKind: kindEnum };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-ml5d.mjs")) {
  const { fixtureCount, schemaKind } = writeAll();
  console.log(`ml5/gen-fixtures-ml5d: wrote ${fixtureCount} fixtures, manifest updated.`);
  console.log(`ml5-fixture schema kind enum: [${schemaKind.join(", ")}]`);
}
