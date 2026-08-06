#!/usr/bin/env node
/**
 * pc-prompt-cache/gen-fixtures-pca.mjs — PC-A messageSeparation flag-unification
 * fixtures.
 *
 * Generates the prompt-cache-fixture schema + the PC-001..004 fixtures under
 * conformance/vector-cortex/v2/ (schemas/ + prompt-cache/), updates the v2
 * manifest with the 4 new fixture rows + 1 schema row + the PC-A owner token,
 * re-sorts, and rewrites the manifest — leaving every pre-existing fixture file
 * and its sha256 untouched (same id-dedupe + seam-header convention as the
 * vector-cortex + vc9-setup-dashboard siblings).
 *
 * Each fixture is a SEMANTIC envelope pinning the PC-A prompt-separation
 * contract:
 *   - 001: flag-on reorders toolResult/bashExecution roles to the tail, keeping
 *     the stable prefix (user/assistant/summaries/custom) contiguous.
 *   - 002: with NO tool results, buildSeparatedPrompt returns the identical
 *     array reference — byte-identical no-op (tail.length === 0 early return).
 *   - 003: flag-off (MEGACOMPACT_MESSAGE_SEPARATION=0) passes prompt arrays
 *     through the call-site gate unchanged — byte-identical to the pre-change
 *     OFF state.
 *   - 004: the mega-config split preserves loadConfig()'s shape — a pure type
 *     move (MegaConfig → mega-config-types.ts), behavior-neutral.
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/pc-prompt-cache/gen-fixtures-pca.mjs`, then
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
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "pc-prompt-cache/gen-fixtures-pca.mjs";

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

// ── prompt-cache-fixture schema ─────────────────────────────────────────────

const ROLE_TYPES = [
  "system",
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
];

const PROMPT_CACHE_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "PC prompt-cache fixture envelope",
  type: "object",
  description:
    "Common structure every PC prompt-cache fixture validates against. These are SEMANTIC envelopes pinning the MEGACOMPACT_MESSAGE_SEPARATION prompt-separation contract: `flag` names the env var, `flag_enabled` pins its state, `input_roles` is the ordered prompt-role sequence before reshaping, `reordered` pins whether tool results moved to the tail, `expected_tail_roles`/`expected_prefix_roles` pin the post-reshape split, `identical_reference` pins the pure no-op (same array returned), and `type_move`/`config_shape_preserved` pin the mega-config type isolation.",
  required: ["id", "producer", "assertion", "kind"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["prompt-cache"] },
    flag: { type: "string" },
    flag_enabled: { type: "boolean" },
    input_roles: { type: "array", items: { type: "string", enum: ROLE_TYPES } },
    expected_tail_roles: { type: "array", items: { type: "string", enum: ROLE_TYPES } },
    expected_prefix_roles: { type: "array", items: { type: "string", enum: ROLE_TYPES } },
    reordered: { type: "boolean" },
    identical_reference: { type: "boolean" },
    type_move: { type: "string" },
    config_shape_preserved: { type: "boolean" },
  },
};

// ── Fixtures (PC-001..004) ──────────────────────────────────────────────────

const FLAG = "MEGACOMPACT_MESSAGE_SEPARATION";

const fixtures = [
  {
    id: "PC-001",
    assertion:
      "flag-on reorders tool results to the tail: with MEGACOMPACT_MESSAGE_SEPARATION enabled (default), buildSeparatedPrompt moves toolResult/bashExecution roles to the tail so the stable prefix (user/assistant/summaries/custom) stays contiguous",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    input_roles: ["user", "assistant", "toolResult", "user", "toolResult"],
    expected_tail_roles: ["toolResult", "toolResult"],
    expected_prefix_roles: ["user", "assistant", "user"],
    reordered: true,
  },
  {
    id: "PC-002",
    assertion:
      "no-tool-results input returns the identical array (pure no-op): an input with zero toolResult/bashExecution roles has tail.length === 0, so buildSeparatedPrompt returns the very same array reference — byte-identical, zero copies",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: true,
    input_roles: ["user", "assistant", "user"],
    reordered: false,
    identical_reference: true,
  },
  {
    id: "PC-003",
    assertion:
      "flag-off passes prompt arrays through unchanged: with MEGACOMPACT_MESSAGE_SEPARATION=0 the call-site gate (tailResult.ts config.messageSeparation) never invokes buildSeparatedPrompt, so prompt arrays pass through byte-identical to the pre-change OFF state",
    kind: "prompt-cache",
    flag: FLAG,
    flag_enabled: false,
    input_roles: ["user", "assistant", "toolResult"],
    reordered: false,
  },
  {
    id: "PC-004",
    assertion:
      "mega-config split preserves loadConfig shape: the MegaConfig interface move to the sibling mega-config-types.ts is a pure type move (type_move) — loadConfig() returns the same config shape (config_shape_preserved), behavior-neutral",
    kind: "prompt-cache",
    flag: FLAG,
    type_move: "MegaConfig→mega-config-types.ts",
    config_shape_preserved: true,
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(PROMPT_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(PROMPT_CACHE_SCHEMA), "utf8");
  const schemaRel = "schemas/prompt-cache-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "prompt-cache-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = { ...fx, schema: "schemas/prompt-cache-fixture.schema.json", producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `prompt-cache/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
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
  setOwnerCsv("owner", "PC-A");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-pca.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`pc-prompt-cache/pca: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
