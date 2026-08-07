#!/usr/bin/env node
/**
 * vector-cortex-dataset.mjs — VC8A offline-learning dataset manifest CLI.
 *
 * A developer / evidence tool (NOT a runtime path) that produces a consent-bound
 * DatasetManifestV1 from a state dir. It reads persisted OutcomeV1 rows
 * (`outcomes.jsonl`) and ConsentV1 records (`consent.jsonl`) from the state dir,
 * captures a single consent high-water, and delegates the grouping / train /
 * calibration / held-out split / reproducible digest to the pure
 * `buildManifest()` function in the compiled dataset module. It also runs the
 * `hasNonconsentedRecords()` invariant check so the export is honest: zero
 * nonconsented rows or a non-zero exit.
 *
 * Because the runtime reporter stores only identity events (never payload), the
 * dataset export reads full records only from files this CLI reads as INPUT
 * (JSON Lines). This aligns with the spec task step 6: "add randomized export
 * fixtures/tests and script" — the CLI is the evidence/export seam, and the
 * adjust-then-export loop lives here, outside the agent loop.
 *
 * LOCAL ONLY (PREVENT-PI-004): reads/writes local files only — zero network.
 * Emits only the manifest rows (payload-free ids/splits), never prompt bytes,
 * response text, or metrics content (EVAL-REDACT-002).
 *
 * Usage:
 *   node scripts/vector-cortex-dataset.mjs
 *       [--state-dir <dir>]
 *       [--outcomes <outcomes.jsonl>]   (override input)
 *       [--consent <consent.jsonl>]     (override input)
 *       [--out <manifest.json>]         (write instead of stdout)
 *       [--high-water <n>]              (override captured consent high-water)
 *
 * Exit codes: 0 = manifest written; 1 = nonconsented records found (honest fail);
 * 2 = infrastructure error (missing dist / unreadable input / bad high-water).
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..");

// State dir lookup mirrors the runtime (MEGACOMPACT_STATE_DIR override first).
const STATE_DIR =
  process.env.MEGACOMPACT_STATE_DIR || join(homedir(), ".pi", "mega-compact");
const DEFAULT_OUTCOMES = join(STATE_DIR, "outcomes.jsonl");
const DEFAULT_CONSENT = join(STATE_DIR, "consent.jsonl");

/** Parse a `--name value` or `--name=value` CLI arg. */
function arg(name, dflt) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] ?? dflt;
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return dflt;
}

/** Read a JSONL file into an array of parsed rows (missing file => []). */
function readJsonl(path) {
  if (!existsSync(path)) {
    throw new Error(`input file not found: ${path}`);
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = JSON.parse(trimmed);
    rows.push(parsed);
  }
  return rows;
}

async function main() {
  const outcomesPath = arg("outcomes", DEFAULT_OUTCOMES);
  const consentPath = arg("consent", DEFAULT_CONSENT);
  const outPath = arg("out", null);
  const highWaterArg = arg("high-water", null); // null => auto-capture

  // The pure subsystem functions are compiled post-build. If dist is missing,
  // exit 2 with an instructive message (same shape as gate-qualify.mjs).
  let m;
  try {
    m = await import("../dist/src/vector-cortex/outcomes/dataset.js");
  } catch (err) {
    console.error(
      "vector-cortex-dataset: dist/src/vector-cortex/outcomes/dataset.js is missing — run `npm run build` first.\n" +
        String(err && err.message || err),
    );
    process.exit(2);
  }

  // Load inputs (local filesystem reads only — PREVENT-PI-004).
  // guardrails-allow PREVENT-PI-004: local filesystem dataset export only (no network)
  const rawOutcomes = readJsonl(outcomesPath);
  // guardrails-allow PREVENT-PI-004: local filesystem dataset export only (no network)
  const rawConsent = readJsonl(consentPath);

  // Capture a single consent high-water (max effectiveSeq across all records),
  // or honor an explicit override for reproducible evidence runs.
  let highWater = null;
  if (highWaterArg !== null) {
    const n = Number(highWaterArg);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`vector-cortex-dataset: invalid --high-water ${highWaterArg}`);
      process.exit(2);
    }
    highWater = n;
  } else {
    for (const r of rawConsent) {
      const seq = r && r.effectiveSeq;
      if (typeof seq === "number" && seq > (highWater ?? 0)) highWater = seq;
    }
    if (highWater === null) highWater = 0;
  }

  const manifest = m.buildManifest(rawOutcomes, rawConsent, highWater);

  // Honest invariant check: refuse to emit a manifest with a nonconsented row.
  if (m.hasNonconsentedRecords(manifest, rawConsent, highWater)) {
    console.error(
      `vector-cortex-dataset: FAILED — manifest contains nonconsented records at high-water ${highWater}`,
    );
    process.exit(1);
  }

  const json = JSON.stringify(manifest, null, 2);
  if (outPath) {
    writeFileSync(outPath, json + "\n", "utf8");
    console.log(
      `vector-cortex-dataset: wrote ${manifest.rows.length} consented rows to ${outPath} (manifest ${manifest.manifestId})`,
    );
  } else {
    console.log(json);
    console.error(
      `vector-cortex-dataset: ${manifest.rows.length} consented rows, manifest ${manifest.manifestId}, high-water ${highWater} (stderr note)`,
    );
  }
}

main().catch((e) => {
  console.error("vector-cortex-dataset: " + ((e && e.message) || e));
  process.exit(2);
});
