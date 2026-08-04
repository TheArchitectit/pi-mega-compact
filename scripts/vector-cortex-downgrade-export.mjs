#!/usr/bin/env node
/**
 * vector-cortex-downgrade-export.mjs — v2 conformance downgrade exporter (VC1C).
 *
 * Produces a NEW legacy copy of the MinHash v2 seed/algorithm snapshot into a
 * deterministic downgrade path. It NEVER edits (and never even opens for write)
 * the authority data it reads: the committed conformance corpus
 * `conformance/vector-cortex/v2/` and the seeds table are left untouched.
 *
 * The resulting `DowngradeReport` (schema "downgrade-report-v1") is
 * deterministic: a second run yields a byte-identical report digest and an
 * identical copy file (CONF-DOWN-003).
 *
 * LOCAL ONLY: reads and writes the local filesystem, zero network
 * (PREVENT-PI-004). Mirrors the DowngradeExporter contract in
 * `src/vector-cortex/conformance/runner.ts`.
 *
 * Usage:
 *   node scripts/vector-cortex-downgrade-export.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const V2 = join(root, "conformance", "vector-cortex", "v2");
const SEEDS = join(V2, "minhash", "seeds-v2.json");
// Downgrade copies live OUTSIDE the v2 conformance root so they never appear
// as unlisted files to `vector-cortex-conformance.mjs --check`.
const OUT_DIR = join(root, "conformance", "vector-cortex", "downgrade");
const OUT_COPY = join(OUT_DIR, "minhash-v2-legacy-copy.json");
const OUT_REPORT = join(OUT_DIR, "downgrade-report.json");

const SCHEMA = "downgrade-report-v1";

// ── Canonical JSON (mirrors the conformance checker) ─────────────────────────

function canonicalNumber(n) {
  if (Number.isInteger(n) && Number.isSafeInteger(n)) return String(n);
  return JSON.stringify(n);
}

function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return canonicalNumber(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalValue(v)).join(",")}]`;
  }
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`);
  return `{${parts.join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(canonicalValue(value) + "\n", "utf8");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Export ───────────────────────────────────────────────────────────────────

function exportOnce() {
  // Authority reads: the seeds table + the high-bit migration fixture.
  const seeds = JSON.parse(readFileSync(SEEDS, "utf8"));
  const seedPairs = (seeds.seedPairs ?? seeds.pairs ?? []).map((p) =>
    typeof p === "object" && p !== null ? p : { a: String(p[0]), b: String(p[1]) },
  );
  const highbitPath = join(V2, "minhash", "M4-HIGHBIT-001.json");
  const highbit = JSON.parse(readFileSync(highbitPath, "utf8"));

  // A self-contained legacy copy: enough to re-derive the v2 signature without
  // importing the TypeScript runner. Never references the authority file paths,
  // so it can outlive the corpus (a real legacy snapshot).
  const copyBody = {
    kind: "minhash-v2-legacy-copy",
    version: 2,
    createdAtUtc: seeds.generatedUtc ?? null,
    seeds: {
      count: seedPairs.length,
      pairs: seedPairs,
    },
    highBitProduct: highbit.expected?.highBitProduct ?? null,
    signatureBytes: 2048,
  };

  const copyCanonical = canonicalBytes(copyBody);
  const copyDigest = sha256(copyCanonical);

  // Deterministic report — no timestamps, no randomness in the digest.
  const reportBody = {
    schema: SCHEMA,
    exportedCopyId: copyDigest.slice(0, 16),
    copiedCount: seedPairs.length,
    unrepresentableIds: [],
    copyDigest,
  };
  const reportCanonical = canonicalBytes(reportBody);
  const reportDigest = sha256(reportCanonical);

  return {
    copyCanonical,
    copyDigest,
    reportBody: { ...reportBody, reportDigest },
    reportDigest,
  };
}

/**
 * Emit the `vector_cortex_downgrade_copy_written` observability event after the
 * legacy copy + report are written (spec task 6). Flag-gated on
 * MEGACOMPACT_VC1C via the built seam; zero emissions when OFF. Non-fatal: a
 * missing dist build or an emission failure never breaks the export.
 */
async function emitDowngradeWritten(out) {
  try {
    const { createConformanceReporter } = await import(
      pathToFileURL(join(root, "dist", "vector-cortex", "conformance", "emit.js")).href
    );
    createConformanceReporter((event, fields) => {
      // Structured JSON line to stdout, mirroring src/log.ts (ts + event).
      process.stdout.write(`${JSON.stringify({ ...fields, event })}\n`);
    }).downgradeWritten({
      exportedCopyId: out.reportBody.exportedCopyId,
      copiedCount: out.reportBody.copiedCount,
      unrepresentableIds: out.reportBody.unrepresentableIds,
      reportDigest: out.reportBody.reportDigest,
    });
  } catch {
    /* non-fatal observability; export already succeeded */
  }
}

async function main() {
  // Regenerate fresh each run (never mutate authority: we only write our OWN
  // downgrade copies under the downgrade/ dir, which are not authority data).
  const out = exportOnce();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_COPY, out.copyCanonical);
  writeFileSync(OUT_REPORT, canonicalBytes(out.reportBody));
  await emitDowngradeWritten(out);

  console.log(`Downgrade export ${SCHEMA}: ${out.reportBody.copiedCount} seeds, copy ${out.copyDigest.slice(0, 16)}, digest ${out.reportDigest.slice(0, 16)}`);
  console.log(`  copy:    ${OUT_COPY}`);
  console.log(`  report:  ${OUT_REPORT}`);
}

main();
