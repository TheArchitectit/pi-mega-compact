#!/usr/bin/env node
/**
 * vector-cortex-gen-fixtures-vc6c-impl.mjs — VC6C-IMPL self-healing fixtures.
 *
 * Emits VC6C-IMPL-001..006 into conformance/vector-cortex/v2/self-healing/ and
 * registers them (with the VC6C-IMPL owner token) in the v2 manifest — strictly
 * additive (same id-dedupe + manifest-rewrite convention as the pc-prompt-cache
 * gen-fixtures-pcd.mjs sibling), leaving every pre-existing fixture file and its
 * sha256 untouched. The schema is REUSED unchanged: the healing domain stays on
 * one canonical schema — `schemas/healing-controller-fixture.schema.json` (the
 * VC6C heal seam's schema, per the VC6C-IMPL spec), so no schema row is emitted.
 *
 * REGENERATION: run `node scripts/vector-cortex-gen-fixtures-vc6c-impl.mjs`,
 * then commit the emitted files; the committed bytes are authoritative for
 * `vector-cortex-conformance.mjs --check`.
 *
 * Each fixture is a SEMANTIC envelope pinning a VC6C-IMPL contract, validated
 * against the healing-controller schema and driven through the REAL heal
 * modules by src/vector-cortex/vc6c-impl-acceptance.test.ts:
 *   - 001: gap detection triggers rebuild (derived behind authority -> plan).
 *   - 002: rate-limit 5min backoff (second rebuild inside window is suppressed).
 *   - 003: atomic pointer switch (verified root flips pointer exactly once).
 *   - 004: RepairPlanV1 production shape (subsystem, range, generation, backoff).
 *   - 005: RepairEventV1 emission (planned/pointer-switched/backoff events).
 *   - 006: no rebuild without a real gap (level-with-authority -> emit nothing).
 *
 * Canonical form, LOCAL-ONLY (PREVENT-PI-004), names/generations/seq only — no
 * rebuilt bytes, no user-content digests (EVAL-REDACT-002).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const SELF_HEALING_DIR = join(V2, "self-healing");

export const producer = "vector-cortex-gen-fixtures-vc6c-impl.mjs";

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

// ── Fixtures (VC6C-IMPL-001..006) ───────────────────────────────────────────

const SCHEMA_REF = "schemas/healing-controller-fixture.schema.json";
const RATE_LIMIT_MS = 5 * 60_000;

/** A single derived subsystem view for a detect-mode row. */
const state = (subsystem, derived, authority, extra = {}) => ({
  subsystem,
  derivedHighWater: derived,
  authorityHighWater: authority,
  lastRebuildAt: null,
  generation: 1,
  mode: "A",
  ...extra,
});

const detect = (scenario, states, nowMs = 1_000_000) => ({
  scenario,
  mode: "detect",
  nowMs,
  states,
});

const rebuild = (scenario, text, expectedDigest, currentGen = 1) => ({
  scenario,
  mode: "rebuild",
  nowMs: 1_000_000,
  states: [],
  rebuild: {
    subsystem: "post_compact",
    generation: currentGen + 1,
    currentGeneration: currentGen,
    sourceBytesBase64: Buffer.from(text).toString("base64"),
    expectedDigest,
    triadMode: "A",
  },
});

const hexOf = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");

const fixture = (id, assertion, input, expected) => ({
  id,
  schema: SCHEMA_REF,
  producer,
  assertion,
  kind: "healing-controller",
  input,
  expected,
});

export const fixtures = [
  fixture(
    "VC6C-IMPL-001",
    "a post-compact derived high-water behind the authority yields a non-empty plan and a rebuild executes",
    detect("gap-triggers-rebuild", [state("post_compact", 5, 9)]),
    { ok: true, plannedCount: 1, ranges: [[6, 9]] },
  ),
  fixture(
    "VC6C-IMPL-002",
    "a second rebuild inside the 5-minute REPAIR_RATE_LIMIT_MS window is suppressed (boundary exclusive)",
    detect("rate-limit-5min", [
      state("post_compact", 5, 9, { lastRebuildAt: 1_000_000 - RATE_LIMIT_MS + 1 }),
    ]),
    { ok: false, code: "HEAL_REPAIR_RATE_LIMITED", plannedCount: 0, ranges: [] },
  ),
  fixture(
    "VC6C-IMPL-003",
    "a verified new-generation root digest flips the pointer exactly once; a failed verification keeps the old pointer and retains evidence",
    rebuild("atomic-pointer-switch", "rebuilt-derived-state", hexOf("rebuilt-derived-state")),
    { ok: true, plannedCount: 0, ranges: [], switched: true, generation: 2, idempotent: true },
  ),
  fixture(
    "VC6C-IMPL-004",
    "RepairPlanV1 production shape { subsystem, range:[seqStart,seqEnd], generation, backoffMs } pins exact plan order from input",
    detect("repair-plan-shape", [
      state("post_compact", 4, 8),
      state("topology", 2, 9),
    ]),
    { ok: true, plannedCount: 2, ranges: [[5, 8], [3, 9]] },
  ),
  fixture(
    "VC6C-IMPL-005",
    "RepairEventV1 emission: vector_cortex_repair_planned / _pointer_switched / _backoff carry subsystem/generation/timings/codes only, never rebuilt bytes or user-content digests",
    detect("repair-event-emission", [state("post_compact", 5, 9)]),
    { ok: true, plannedCount: 1, ranges: [[6, 9]] },
  ),
  fixture(
    "VC6C-IMPL-006",
    "level-with-authority (or ahead) subsystems emit nothing and rebuild is a no-op (no rebuild without a real gap)",
    detect("no-gap-no-rebuild", [state("post_compact", 9, 9)]),
    { ok: true, plannedCount: 0, ranges: [] },
  ),
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(SELF_HEALING_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];
  for (const fx of fixtures) {
    const bytes = Buffer.from(canonicalJson(fx), "utf8");
    const rel = `self-healing/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: SCHEMA_REF,
      algorithm: "healing-controller",
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
  setOwnerCsv("VC6C-IMPL");

  // Add the self-healing domain token (new fixture seam).
  const domainList = manifest.domain.split(",").map((s) => s.trim()).filter(Boolean);
  if (!domainList.includes("self-healing")) domainList.push("self-healing");
  manifest.domain = domainList.sort().join(",");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length };
}

if (process.argv[1] && process.argv[1].endsWith("vector-cortex-gen-fixtures-vc6c-impl.mjs")) {
  const { fixtureCount } = writeAll();
  console.log(`vc6c-impl: wrote ${fixtureCount} fixtures, manifest updated.`);
}
