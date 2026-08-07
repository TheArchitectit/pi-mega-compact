#!/usr/bin/env node
/**
 * mock-scan.mjs — PREVENT-MOCK-001 scanner.
 *
 * Scans src/ and extensions/ (non-test .ts/.js) for mock/fake/synthetic data
 * presented as real measurements in a production path: `Math.random()` /
 * seeded PRNG, hash-functions used as embeddings (fnv1a-markers / hash-as-
 * embedding), and hardcoded metric tables returned as measurements. A detected
 * occurrence is REGISTERED (non-fatal under --fail-on-unregistered) when it
 * carries a `// guardrails-allow PREVENT-MOCK-001: <reason — accuracy-floor
 * acknowledged>` annotation on the same line or the immediately-preceding
 * comment line. The reason MUST name or acknowledge an accuracy floor.
 *
 * Modes:
 *   default                 — report every occurrence; exit 1 if any found.
 *   --fail-on-unregistered  — fail ONLY on occurrences without a valid allow
 *                             annotation. Wired into `npm run lint` so a NEW
 *                             mock without an acknowledged accuracy floor fails
 *                             at the sprint boundary (framework §5).
 *
 * LOCAL ONLY: filesystem reads, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/mock-scan.mjs [--fail-on-unregistered]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src", "extensions"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** PRNG / randomness markers that fabricate deterministic or random sequences. */
const PRNG_RE = /\bMath\.random\s*\(|seedrandom|mulberry32/;

/** LCG constants (deterministic fake randomness). */
const LCG_RE = /\b1664525\b|\b1013904223\b/;

/**
 * Hash-as-embedding markers — a hash projected into a vector that is then
 * presented as an embedding. This intentionally matches the embedding-projection
 * shape (a hash feeding `vec[]` that becomes the embedding), NOT bare FNV-1a
 * dedup/bloom hashing (src/cache-stripe-score.ts fnv1a for bit indices is a real
 * hash, not an embedding). Named marker words are matched too.
 */
const HASH_AS_EMBEDDING_RE =
  /\b(fallbackEmbed|hash-as-embedding|hashAsEmbedding|hashed[- ]n-gram embedding)\b|\bvec\[\s*(?:Math\.floor\(\s*)?fnv1a/;

/** Hardcoded metric tables returned as measurements. */
const METRIC_TABLE_RE = /\b(hardcodedMetric|fakeMetric|metricTable|fixtureMetrics)\b/i;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, acc);
    } else if (
      /\.(ts|js)$/.test(name) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.js") &&
      !name.endsWith(".spec.ts") &&
      !name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

function isCommentOnly(line) {
  const s = line.trim();
  return s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("/**");
}

/** Allow annotation visible on this line or a nearby preceding comment block. */
function allowOn(lines, idx) {
  const re = /guardrails-allow\s+PREVENT-MOCK-001\s*:\s*(.+)$/i;
  // A block-level allow at a function/comment header can govern a whole body, so
  // scan back past the enclosing block start (def line) up to 20 lines.
  const scanRange = Math.max(0, idx - 20);
  for (let i = idx; i >= scanRange; i--) {
    const m = lines[i] ? lines[i].match(re) : null;
    if (m) return m[1];
  }
  return null;
}

/** The allow reason must acknowledge an accuracy floor (e.g. "accuracy floor", "synthetic", "seeded"). */
function acknowledgeFloor(reason) {
  return /\b(accuracy floor|accuracy-floor|synthetic|seeded|deterministic|fixture-only|measurement floor|placeholder metrology)\b/i.test(reason);
}

function main() {
  const failOnUnregistered = process.argv.includes("--fail-on-unregistered");
  let files = [];
  for (const dir of SCAN_ROOTS) files = files.concat(walk(join(root, dir)));

  let failures = 0;
  const reports = [];

  for (const file of files) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const code = isCommentOnly(line) ? "" : line;

      const prng = PRNG_RE.exec(code);
      const lcg = LCG_RE.exec(code);
      const hash = HASH_AS_EMBEDDING_RE.exec(line);
      const table = METRIC_TABLE_RE.exec(code);

      let matched = null;
      if (prng) matched = prng[0];
      else if (lcg) matched = lcg[0];
      else if (hash) matched = hash[0];
      else if (table) matched = table[0];
      if (!matched) continue;

      const reason = allowOn(lines, i);
      const floorOk = reason !== null && acknowledgeFloor(reason);
      const lineStr = line.trim();
      reports.push({ rel, line: i + 1, matched, lineStr, reason, floorOk });

      if (failOnUnregistered) {
        if (!floorOk) {
          const why =
            reason === null
              ? "no guardrails-allow PREVENT-MOCK-001"
              : "allow reason does not acknowledge an accuracy floor";
          console.error(`[MOCK] ${rel}:${i + 1} — ${matched} (${why})`);
          failures++;
        }
      } else if (!floorOk) {
        console.error(`[MOCK] ${rel}:${i + 1} — ${matched} (no accuracy-floor allow)`);
        failures++;
      }
    }
  }

  const registered = reports.filter((r) => r.floorOk).length;
  const msg = `MOCK-SCAN: ${reports.length} occurrence(s), ${registered} acknowledged, ${failures} failing (mode=${failOnUnregistered ? "fail-on-unregistered" : "strict"}).`;
  if (failures > 0) {
    console.error(msg);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error("mock-scan error:", e.message);
  process.exit(1);
}
