#!/usr/bin/env node
/**
 * pc-prompt-cache/gen-fixtures-pcb.mjs — PC-B cacheStriping flag-unification
 * fixtures.
 *
 * Generates the PC-005..008 fixtures under conformance/vector-cortex/v2/
 * (prompt-cache/), updates the v2 manifest with the 4 new fixture rows + the
 * PC-B owner token, re-sorts, and rewrites the manifest — leaving every
 * pre-existing fixture file and its sha256 untouched (same id-dedupe +
 * seam-header convention as the pca + vector-cortex + vc9-setup-dashboard
 * siblings, and strictly additive: the existing prompt-cache-fixture schema
 * from PC-A is reused unchanged, so no schema row is emitted).
 *
 * Each fixture is a SEMANTIC envelope pinning the PC-B cache-striping
 * contract (same prompt-cache-fixture schema as PC-A; additional fields are
 * permitted since the schema does not set additionalProperties:false):
 *   - 005: flag-on inserts the cache-stripe layer between summaries and
 *     thread, ordering stripe content by stability score DESC
 *     (expected_layer_order summary->stripe->thread->tool).
 *   - 006: flag-on with NO cache_stripes rows for the epoch falls back to the
 *     base separated prompt unchanged — byte-identical to PC-A behavior.
 *   - 007: flag-off (MEGACOMPACT_CACHE_STRIPING=0) skips buildCacheOptimized
 *     Prompt entirely; with message-separation on (the default), only
 *     separation runs — result matches PC-A-only output exactly.
 *   - 008: the delegation chain buildCacheOptimizedPrompt ->
 *     buildSeparatedPrompt -> tail_reorder produces the correct 5-layer
 *     output (chain_correct).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/pc-prompt-cache/gen-fixtures-pcb.mjs`, then
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

export const producer = "pc-prompt-cache/gen-fixtures-pcb.mjs";

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

// ── Fixtures (PC-005..008) ──────────────────────────────────────────────────

const FLAG = "MEGACOMPACT_CACHE_STRIPING";
const SCHEMA_REF = "schemas/prompt-cache-fixture.schema.json";

const fixtures = [
  {
    id: "PC-005",
    assertion:
      "flag-on inserts the cache-stripe layer between summaries and thread: with MEGACOMPACT_CACHE_STRIPING enabled (default) and cache_stripes rows present for the epoch, buildCacheOptimizedPrompt places durable stripe context after the summary layer and before the conversation thread, ordered by stability score DESC — expected_layer_order summary->stripe->thread->tool",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    stripes_present: true,
    expected_layer_order: ["summary", "stripe", "thread", "tool"],
    reordered: true,
  },
  {
    id: "PC-006",
    assertion:
      "no-stripes fallback returns the separated prompt unchanged: with MEGACOMPACT_CACHE_STRIPING enabled but no cache_stripes rows for the current epoch, the stripe layer is empty and buildCacheOptimizedPrompt returns the base separated prompt — byte-identical to the PC-A output (falls_back_to_separation)",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    stripes_present: false,
    falls_back_to_separation: true,
    reordered: true,
  },
  {
    id: "PC-007",
    assertion:
      "flag-off delegates to messageSeparation only: with MEGACOMPACT_CACHE_STRIPING=0 the call-site gate (tailResult.ts config.cacheStriping) skips buildCacheOptimizedPrompt entirely; with message_separation also on (the default) only separation runs — result matches the PC-A-only output byte-for-byte",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: false,
    message_separation_also_on: true,
    result_matches: "PC-A-only",
    reordered: true,
  },
  {
    id: "PC-008",
    assertion:
      "delegation chain preserves tail reordering: the full chain buildCacheOptimizedPrompt -> buildSeparatedPrompt -> tail_reorder produces the correct 5-layer output — stripe layer inserted, tool results moved to the tail, stable prefix contiguous (chain_correct)",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    delegation_chain: ["buildCacheOptimizedPrompt", "buildSeparatedPrompt", "tail_reorder"],
    chain_correct: true,
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

  const setOwnerCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setOwnerCsv("owner", "PC-B");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-pcb.mjs")) {
  const { fixtureCount } = writeAll();
  console.log(`pc-prompt-cache/pcb: wrote ${fixtureCount} fixtures, manifest updated.`);
}
