#!/usr/bin/env node
/**
 * vector-cortex-evidence-check.mjs — validate an evidence record's CONCRETE
 * claims against the shipped tree, so evidence can never drift from reality.
 *
 * An evidence record that says "25/25 tests pass in both flag states" or
 * "store.ts 380" is making a falsifiable claim. This gate re-derives each such
 * claim from the actual repository and fails when they disagree.
 *
 * Checks (flag codes are stable; the controller greps for them):
 *   EVIDENCE_LINE_COUNT_MISMATCH      — "`path` (N)" / "path N" != real wc -l
 *   EVIDENCE_TEST_COUNT_MISMATCH      — claimed acceptance counts != real run
 *   EVIDENCE_FLAG_PARITY_MISMATCH     — MEGACOMPACT_X=0 run != claimed counts
 *   EVIDENCE_FIXTURE_COUNT_MISMATCH   — fixture count != manifest (latest only)
 *   EVIDENCE_REVIEWER_ATTESTATION_MISSING — implementer-complete, no attestation (WARN)
 *
 * Never auto-fixes: it prints the REAL current value beside the claim so the
 * controller (who owns the evidence) can correct the record.
 *
 * LOCAL ONLY: filesystem reads + local `node --test` invocation, zero network
 * (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/vector-cortex-evidence-check.mjs VC1B
 *   node scripts/vector-cortex-evidence-check.mjs --all
 *   node scripts/vector-cortex-evidence-check.mjs VC1B --no-run   # skip test exec
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseLineClaims,
  parseTestClaims,
  parseFixtureClaims,
  parseStatus,
  parseAttestation,
} from "./vector-cortex-evidence-claims.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(scriptDir, "..");

/** Directories a bare filename claim may resolve under, in priority order. */
const SEARCH_ROOTS = ["src", "extensions", "scripts", "conformance", "docs", "assets", "training"];

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function countLines(file) {
  const text = readFileSync(file, "utf8");
  // `wc -l` counts newline characters; a trailing final LF is not an extra line.
  const nl = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? nl : nl + 1;
}

/** Recursively collect files whose path ends with `suffix`. */
function findBySuffix(root, suffix, limit = 8) {
  const hits = [];
  const skip = new Set(["node_modules", ".git", "dist", ".claude", "coverage"]);
  const walk = (dir) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(suffix)) hits.push(p);
    }
  };
  for (const r of SEARCH_ROOTS) {
    const base = join(root, r);
    if (exists(base)) walk(base);
  }
  return hits;
}

/**
 * Resolve a claimed path to a real file.
 * - repo-relative path that exists -> resolved
 * - otherwise search by path suffix; exactly one hit -> resolved,
 *   several hits -> ambiguous (skipped, reported), none -> missing.
 */
export function resolveClaimPath(root, claimed) {
  const direct = join(root, claimed);
  if (exists(direct) && statSync(direct).isFile()) {
    return { status: "resolved", file: direct, rel: claimed };
  }
  const suffix = claimed.startsWith("/") ? claimed : `/${claimed}`;
  const hits = findBySuffix(root, suffix);
  if (hits.length === 1) {
    return { status: "resolved", file: hits[0], rel: hits[0].slice(root.length + 1) };
  }
  if (hits.length > 1) {
    return { status: "ambiguous", candidates: hits.map((h) => h.slice(root.length + 1)) };
  }
  return { status: "missing" };
}

/** Run `node --test <file>` (optionally with a MEGACOMPACT flag off) and parse counts. */
function runNodeTest(root, relFile, flagVar) {
  const env = { ...process.env };
  // If this checker is itself run under `node --test`, the child inherits the
  // runner's context vars and switches to worker/TAP mode, emitting no
  // "ℹ tests N" summary. Strip them so the child is always a top-level run.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  if (flagVar) env[flagVar] = "0";
  const res = spawnSync(process.execPath, ["--test", relFile, "--test-reporter", "spec"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 300_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const num = (label) => {
    const m = new RegExp(`^\\s*\\u2139\\s*${label}\\s+(\\d+)`, "m").exec(out);
    return m ? Number(m[1]) : null;
  };
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), code: res.status, out };
}

/** Fixture count from the conformance manifest (authoritative, no spawn). */
function manifestFixtureCount(root) {
  const p = join(root, "conformance", "vector-cortex", "v2", "manifest.json");
  if (!exists(p)) return null;
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (!parsed || !Array.isArray(parsed.fixtures)) return null;
  return parsed.fixtures.length;
}

/**
 * Validate one evidence record. Returns {sprint, problems[], warnings[], notes[], checked}.
 * `problems` are exit-1 failures; `warnings` and `notes` are informational.
 */
export function checkEvidence(sprint, opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const run = opts.run !== false;
  const latestSprint = opts.latestSprint ?? null;
  const problems = [];
  const warnings = [];
  const notes = [];
  let checked = 0;

  const file = join(root, "docs", "vector-cortex", "evidence", `${sprint}.md`);
  if (!exists(file)) {
    problems.push({ code: "EVIDENCE_MISSING", detail: `no evidence record at ${file}` });
    return { sprint, problems, warnings, notes, checked };
  }
  const md = readFileSync(file, "utf8");

  // 1 — line-count claims
  for (const claim of parseLineClaims(md)) {
    const r = resolveClaimPath(root, claim.path);
    if (r.status === "missing") {
      notes.push(`unresolved path (skipped): ${claim.path} — no such file in tree`);
      continue;
    }
    if (r.status === "ambiguous") {
      notes.push(
        `ambiguous path (skipped): ${claim.path} → ${r.candidates.length} candidates ` +
          `(${r.candidates.slice(0, 3).join(", ")}…); qualify the path in the evidence to make it checkable`,
      );
      continue;
    }
    checked++;
    const actual = countLines(r.file);
    if (actual !== claim.lines) {
      problems.push({
        code: "EVIDENCE_LINE_COUNT_MISMATCH",
        detail: `${r.rel}: evidence claims ${claim.lines} lines, actual ${actual} (claim text: "${claim.raw}")`,
      });
    }
  }

  // 2/3 — acceptance test-count + flag-off parity claims.
  //
  // A claim is held to HEAD (its counts must match the real run TODAY) only when
  // the test file is OWNED by this sprint: a sprint's own acceptance aggregator
  // basename carries the sprint id (e.g. `vc1b-acceptance.test.js` for VC1B), or
  // this is the latest sprint. A shared cross-sprint suite (rag-settings,
  // routes-vector-cortex, a unit suite like `heads.test.js`) grows as every
  // later sprint adds a case — for a prior sprint its recorded count is a
  // legitimate historical fact, not a HEAD obligation. This mirrors the
  // fixture-count rule below. We still EXECUTE shared suites for prior sprints:
  // a red shared suite is a real regression even if its count drifted, so a
  // nonzero fail count always fails.
  const lowerSprint = sprint.toLowerCase();
  for (const claim of parseTestClaims(md)) {
    const target = join(root, claim.file);
    if (!exists(target)) {
      notes.push(
        `test artifact absent (skipped): ${claim.file} — run \`npm run build\` for full validation`,
      );
      continue;
    }
    if (!run) {
      notes.push(`--no-run: skipped executing ${claim.raw}`);
      continue;
    }
    // A sprint's own acceptance aggregator carries the sprint id; the synthetic
    // VCTEST fixtures use `vctest.test.js`. The latest sprint's *every* suite is
    // HEAD-bound (it owns the current top of the chain).
    const isSprintOwned =
      /[/\\]vc[0-9][a-z][^./-]*-acceptance\.test\.js$/i.test(claim.file) ||
      /[/\\]vctest\.test\.js$/i.test(claim.file) ||
      latestSprint === sprint;
    checked++;
    const got = runNodeTest(root, claim.file, claim.flagOff ? claim.flagVar : null);
    const code = claim.flagOff ? "EVIDENCE_FLAG_PARITY_MISMATCH" : "EVIDENCE_TEST_COUNT_MISMATCH";
    if (got.tests === null || got.pass === null) {
      problems.push({
        code,
        detail: `${claim.raw}: could not parse a test summary (exit ${got.code}) — the command in the evidence does not run`,
      });
      continue;
    }
    // A red suite is always a real regression, even for a prior sprint's claim.
    if ((got.fail ?? 0) > 0 || got.code !== 0) {
      problems.push({
        code,
        detail: `${claim.raw}: reported ${got.fail} failing tests (exit ${got.code}) despite a green claim`,
      });
      continue;
    }
    if (!isSprintOwned) {
      notes.push(
        `shared cross-sprint suite (historical for ${sprint}): ${claim.raw} — claimed ` +
          `${claim.tests}/${claim.pass}, HEAD is ${got.tests}/${got.pass}; count not held to HEAD`,
      );
      continue;
    }
    if (got.tests !== claim.tests || got.pass !== claim.pass) {
      problems.push({
        code,
        detail:
          `${claim.raw}: evidence claims tests ${claim.tests} / pass ${claim.pass}, ` +
          `actual tests ${got.tests} / pass ${got.pass} / fail ${got.fail ?? "?"}`,
      });
    }
  }

  // 4 — fixture counts. Only the CURRENT sprint's claim must equal HEAD; an
  // older record's count is a legitimate historical fact (the corpus grows).
  const fixtureClaims = parseFixtureClaims(md);
  if (fixtureClaims.length > 0) {
    const actual = manifestFixtureCount(root);
    if (actual === null) {
      notes.push("conformance manifest not found — fixture claims not validated");
    } else if (latestSprint !== null && sprint !== latestSprint) {
      notes.push(
        `fixture claims (${fixtureClaims.map((c) => c.count).join(", ")}) treated as historical; ` +
          `HEAD manifest has ${actual} (only ${latestSprint} is held to HEAD)`,
      );
    } else {
      checked++;
      const match = fixtureClaims.some((c) => c.count === actual);
      if (!match) {
        problems.push({
          code: "EVIDENCE_FIXTURE_COUNT_MISMATCH",
          detail:
            `evidence claims ${fixtureClaims.map((c) => c.count).join("/")} fixtures, ` +
            `manifest has ${actual}`,
        });
      }
    }
  }

  // 5 — status vs reviewer attestation (warning: attestation is the controller's act)
  const status = parseStatus(md);
  const attestation = parseAttestation(md);
  if (status === "implementer-complete" && !attestation.present) {
    warnings.push({
      code: "EVIDENCE_REVIEWER_ATTESTATION_MISSING",
      detail: `Status is "implementer-complete" but the reviewer attestation is ${
        attestation.text ? `not an attestation ("${attestation.text.split("\n")[0].slice(0, 60)}")` : "absent"
      }`,
    });
  }

  if (checked === 0 && problems.length === 0) {
    notes.push("no concrete claims to validate");
  }
  return { sprint, problems, warnings, notes, checked };
}

/** Every sprint that has an evidence record, sorted. */
export function listSprints(root = DEFAULT_ROOT) {
  const dir = join(root, "docs", "vector-cortex", "evidence");
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

function report(result) {
  const { sprint, problems, warnings, notes, checked } = result;
  const head = problems.length === 0 ? "✓" : "✗";
  console.log(`\n${head} ${sprint} — ${checked} claim(s) validated`);
  for (const n of notes) console.log(`    note: ${n}`);
  for (const w of warnings) console.log(`    WARN ${w.code}: ${w.detail}`);
  for (const p of problems) console.log(`    FAIL ${p.code}: ${p.detail}`);
}

function main(argv) {
  const args = argv.slice(2);
  const run = !args.includes("--no-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const all = args.includes("--all");
  if (!all && positional.length === 0) {
    console.error("usage: node scripts/vector-cortex-evidence-check.mjs <SPRINT_ID> | --all [--no-run]");
    return 2;
  }
  const sprints = all ? listSprints() : positional;
  if (sprints.length === 0) {
    console.error("no evidence records found");
    return 2;
  }
  const latestSprint = listSprints().at(-1) ?? null;

  const results = sprints.map((s) => checkEvidence(s, { run, latestSprint }));
  results.forEach(report);

  const failed = results.filter((r) => r.problems.length > 0);
  const warned = results.reduce((n, r) => n + r.warnings.length, 0);
  console.log(
    `\nEVIDENCE-CHECK: ${results.length} record(s), ${failed.length} with mismatches, ${warned} warning(s).`,
  );
  if (failed.length > 0) {
    console.log("Evidence is the controller's to correct — the real values are printed above.");
    return 1;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("vector-cortex-evidence-check.mjs")) {
  process.exit(main(process.argv));
}
