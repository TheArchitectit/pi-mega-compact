#!/usr/bin/env node
/**
 * vector-cortex-conformance.mjs — v2 conformance fixture checker (VC0A).
 *
 * Validates the authoritative manifest `conformance/vector-cortex/v2/manifest.json`
 * and every fixture it lists under the v2 root. Fails (exit 1) on:
 *   - absent file (listed in manifest but missing on disk)
 *   - unlisted/extra file (on disk under v2 root but not in manifest)
 *   - digest drift (on-disk bytes != manifest SHA-256 over canonical bytes)
 *   - schema error (fixture fails the JSON Schema it references)
 *   - duplicate fixture ID
 *   - noncanonical JSON (re-serialization differs from committed bytes)
 *
 * Mirrors CONFORMANCE.md §canonical rules: UTF-8, NFC keys, keys sorted by
 * UTF-8 bytes, shortest number representation, final LF, unpadded base64 for
 * binary fields, SHA-256 over the declared canonical bytes.
 *
 * LOCAL ONLY: reads the filesystem, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/vector-cortex-conformance.mjs --check
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const V2 = join(root, "conformance", "vector-cortex", "v2");
const MANIFEST_PATH = join(V2, "manifest.json");

const OK = "✓";

// ── Canonical JSON ──────────────────────────────────────────────────────────

/** Shortest JSON number representation (no trailing .0, no exponent if int). */
function canonicalNumber(n) {
  if (Number.isInteger(n) && Number.isSafeInteger(n)) return String(n);
  return JSON.stringify(n);
}

function canonicalValue(value, keyForSort) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new Error(`non-canonical number: ${value}`);
      }
      return canonicalNumber(value);
    }
    return JSON.stringify(value); // strings, booleans, null
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalValue(v)).join(",")}]`;
  }
  // Object: UTF-8 NFC keys sorted by UTF-8 byte order (code-unit order for
  // the ASCII-relevant keys used here).
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`);
  return `{${parts.join(",")}}`;
}

/** Canonical UTF-8 JSON bytes with a trailing LF. */
export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalValue(value) + "\n", "utf8");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Filesystem helpers ──────────────────────────────────────────────────────

function walk(dir, base, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc.push(relative(base, p).split(sep).join("/"));
  }
  return acc.sort();
}

function canonicalBufferFor(p) {
  // Special-case: manifest/non-fixture files are canonicalized too, but any
  // listed .json is canonicalized; non-JSON (README? none here) kept raw.
  if (p.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return canonicalJsonBytes(parsed);
  }
  return readFileSync(p);
}

function validateSchema(fixture, relPath, issues) {
  const schemaPath = fixture.schema ? join(V2, fixture.schema) : null;
  if (!fixture.schema) return; // admin entry with no schema
  if (!schemaPath || !exists(schemaPath)) {
    issues.push(`schema not found for ${relPath}: ${fixture.schema}`);
    return;
  }
  const validator = loadSchemaValidator(schemaPath);
  if (!validator || !validator(fixture)) {
    issues.push(`schema error in ${relPath} against ${fixture.schema}`);
  }
}

// Minimal JSON Schema validator: handles the constructs produced by our schema
// files (type, required, properties, items, enum, additionalProperties). Full
// Draft-07 is out of scope; we validate the subset our committed schemas use.
function loadSchemaValidator(schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  function check(node, value, path, errors) {
    if (node.type === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      for (const req of node.required ?? []) {
        if (!(req in value)) errors.push(`${path}: missing required '${req}'`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (node.properties && k in node.properties) {
          check(node.properties[k], v, `${path}.${k}`, errors);
        } else if (node.additionalProperties === false) {
          errors.push(`${path}: unexpected property '${k}'`);
        }
      }
    } else if (node.type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      if (node.items) {
        for (let i = 0; i < value.length; i++) {
          check(node.items, value[i], `${path}[${i}]`, errors);
        }
      }
    } else if (node.type === "string") {
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      else if (node.enum && !node.enum.includes(value)) {
        errors.push(`${path}: not in enum (got '${value}')`);
      }
    } else if (node.type === "number" || node.type === "integer") {
      if (typeof value !== "number") errors.push(`${path}: expected number`);
      else if (node.type === "integer" && !Number.isInteger(value)) {
        errors.push(`${path}: expected integer`);
      }
    } else if (node.type === "boolean") {
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
    }
  }
  return (fixture) => {
    const errors = [];
    check(schema, fixture, "$", errors);
    return errors.length === 0;
  };
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ── Main check ──────────────────────────────────────────────────────────────

function check() {
  if (!exists(MANIFEST_PATH)) {
    console.error(`CONFORMANCE: missing ${relative(root, MANIFEST_PATH)}`);
    process.exit(1);
  }
  // Manifest must itself be canonical.
  const manifestRaw = readFileSync(MANIFEST_PATH, "utf8");
  const manifestParsed = JSON.parse(manifestRaw);
  if (manifestRaw !== canonicalJsonBytes(manifestParsed).toString("utf8")) {
    console.error("CONFORMANCE: manifest.json is noncanonical");
    process.exit(1);
  }
  const entries = manifestParsed.fixtures;
  if (!Array.isArray(entries)) {
    console.error("CONFORMANCE: manifest has no fixtures[] array");
    process.exit(1);
  }

  const issues = [];
  const seenIds = new Set();
  const seenPaths = new Set();

  for (const f of entries) {
    const rel = f.path;
    const abs = join(V2, rel);
    if (seenIds.has(f.id)) issues.push(`duplicate fixture ID: ${f.id}`);
    seenIds.add(f.id);
    if (seenPaths.has(rel)) issues.push(`duplicate fixture path: ${rel}`);
    seenPaths.add(rel);

    if (!exists(abs)) {
      issues.push(`absent file: ${rel}`);
      continue;
    }
    const canonical = canonicalBufferFor(abs);
    const actualHex = sha256(canonical);
    const expectedHex = String(f.sha256 ?? "");
    if (expectedHex === "") {
      issues.push(`missing sha256 for ${rel}`);
    } else if (actualHex !== expectedHex) {
      issues.push(`digest drift for ${rel}: expected ${expectedHex} got ${actualHex}`);
    }
    // Noncanonical JSON detection: re-serialize and byte-compare.
    if (rel.endsWith(".json")) {
      const raw = readFileSync(abs, "utf8");
      if (raw !== canonicalJsonBytes(JSON.parse(raw)).toString("utf8")) {
        issues.push(`noncanonical JSON: ${rel}`);
      }
    }
    validateSchema(JSON.parse(readFileSync(abs, "utf8")), rel, issues);
  }

  // Extra-file detection: every file under v2 root (except manifest) is listed.
  const onDisk = walk(V2, V2).filter((p) => p !== "manifest.json");
  for (const p of onDisk) {
    if (!seenPaths.has(p)) issues.push(`unlisted file: ${p}`);
  }
  // Absent-but-listed is already caught above (every entry checked for exists).

  if (issues.length > 0) {
    console.error(`CONFORMANCE: ${issues.length} issue(s):`);
    for (const i of issues) console.error(`  - ${i}`);
    process.exit(1);
  }
  console.log(`${OK} CONFORMANCE: v2 manifest + ${entries.length} fixtures canonical (${onDisk.length} files).`);
  process.exit(0);
}

const mode = process.argv[2];
if (mode === "--check") check();
else {
  console.error("Usage: node scripts/vector-cortex-conformance.mjs --check");
  process.exit(2);
}
