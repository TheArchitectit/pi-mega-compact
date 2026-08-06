#!/usr/bin/env node
/**
 * pc-prompt-cache/gen-fixtures-pcc.mjs — PC-C dashboard prefix-stability fixtures.
 *
 * Generates the PC-009..015 fixtures under conformance/vector-cortex/v2/
 * (prompt-cache/), updates the v2 manifest with the 7 new fixture rows + the
 * PC-C owner token, re-sorts, and rewrites the manifest — leaving every
 * pre-existing fixture file and its sha256 untouched (same id-dedupe +
 * seam-header convention as the pca/pcb + vector-cortex + vc9-setup-dashboard
 * siblings, and strictly additive: the existing prompt-cache-fixture schema
 * from PC-A is reused unchanged, so no schema row is emitted).
 *
 * Each fixture is a SEMANTIC envelope pinning the PC-C prefix-stability contract
 * (the per-turn stable-prefix ratio trend surfaced in the dashboard Cache tab),
 * with field names + ids matching the PC-C sprint spec's failure-triad exactly:
 *   - 009: flag-on GET /api/prefix-stability returns a non-empty trend series
 *     (turns[] with stablePrefix/totalMessages/ratio) from real prefix_stability
 *     events in the monitoring events log.
 *   - 010: no prefix_stability events (fresh session) -> empty turns array with
 *     zero returned turns (empty-state early return).
 *   - 011: flag-off (MEGACOMPACT_PC_C=0) -> 404, CacheTab omits PrefixStabilityCard
 *     (byte-identical Cache tab to the PC-B predecessor).
 *   - 012: trend_classification "improving" (recent ratios > earlier ratios).
 *   - 013: trend_classification "stable" (recent ~= earlier ratios).
 *   - 014: trend_classification "degrading" (recent < earlier ratios).
 *   - 015: registry integration — /api/prefix-stability registered with the
 *     PrefixStabilityResponse contract, EXPECTED_ENDPOINT_COUNT bumped.
 *
 * Also pins (PC-013's supplementary fields + behind the fixture envelope) the
 * data-source guarantee that the route reads prefix_stability rows from the
 * always-on monitoring events log (appendEvent), not the debug-gated logger.
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/pc-prompt-cache/gen-fixtures-pcc.mjs`, then
 * commit the emitted files. The committed files are authoritative.
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
const PROMPT_DIR = join(V2, "prompt-cache");

export const producer = "pc-prompt-cache/gen-fixtures-pcc.mjs";

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

// ── Fixtures (PC-009..015) ──────────────────────────────────────────────────

const FLAG = "MEGACOMPACT_PC_C";
const SCHEMA_REF = "schemas/prompt-cache-fixture.schema.json";

const fixtures = [
  {
    id: "PC-009",
    assertion:
      "flag-on returns a non-empty trend series from real prefix_stability events: with MEGACOMPACT_PC_C enabled (default), GET /api/prefix-stability reads recent prefix_stability rows from the monitoring events log and returns turns[] (stablePrefix/totalMessages/ratio per turn) plus avgRatio + trend",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    endpoint: "/api/prefix-stability",
    events_present: true,
    turns_returned: ">0",
  },
  {
    id: "PC-010",
    assertion:
      "empty state: with the flag on but no prefix_stability events logged yet (fresh session), the endpoint returns an empty turns array with zero returned turns and the client renders a no-data state",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    events_present: false,
    turns_returned: 0,
  },
  {
    id: "PC-011",
    assertion:
      "flag-off returns 404 and the CacheTab omits the PrefixStabilityCard: with MEGACOMPACT_PC_C=0, GET /api/prefix-stability returns 404 and the Cache tab renders exactly as the PC-B predecessor (stripe distribution + hit-rate trend only)",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: false,
    endpoint_status: 404,
    card_present: false,
  },
  {
    id: "PC-012",
    assertion:
      "trend classification 'improving': a window whose recent (tail) ratios exceed the earlier (head) ratios by more than the 0.05 threshold is classified improving (tail > head)",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    trend_classification: "improving",
  },
  {
    id: "PC-013",
    assertion:
      "trend classification 'stable': a window whose recent ratios roughly equal the earlier ratios (within the 0.05 threshold) is classified stable. Data source: prefix_stability rows are read from the always-on monitoring events log via appendEvent {ts,event,...fields}, not the debug-gated mega-compact.log logger",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    trend_classification: "stable",
    read_source: "monitoring events log",
    append_event_shape: true,
    debug_logger: false,
  },
  {
    id: "PC-014",
    assertion:
      "trend classification 'degrading': a window whose recent (tail) ratios fall below the earlier (head) ratios by more than the -0.05 threshold is classified degrading (tail < head)",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    trend_classification: "degrading",
  },
  {
    id: "PC-015",
    assertion:
      "registry integration: /api/prefix-stability is registered in the ENDPOINTS registry with the PrefixStabilityResponse contract shape and EXPECTED_ENDPOINT_COUNT is bumped (52 -> 53)",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    registry_entry: "/api/prefix-stability",
    contract_shape: "PrefixStabilityResponse",
    endpoint_count_bumped: true,
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
  setOwnerCsv("PC-C");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-pcc.mjs")) {
  const { fixtureCount } = writeAll();
  console.log(`pc-prompt-cache/pcc: wrote ${fixtureCount} fixtures, manifest updated.`);
}
