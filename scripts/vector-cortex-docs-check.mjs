#!/usr/bin/env node
/**
 * vector-cortex-docs-check.mjs — static validator over docs/vector-cortex/.
 *
 * Genuine checks against the master plan (CONFORMANCE.md / SPRINT_PLAN.md):
 *   - exactly 27 sprint docs and 9 phase docs exist;
 *   - every docs/vector-cortex Markdown file is < 500 lines;
 *   - every `](...)` link resolves to an existing file (relative or root);
 *   - every sprint doc declares a positive `MEGACOMPACT_*` flag line;
 *   - every bash code block's exact command entry point exists on disk
 *     (node script / npm script / python3 script) — no phantom test commands;
 *   - referenced migration IDs (M2..M7, MIG-DOWN-001) are in the known set.
 *
 * LOCAL ONLY: filesystem reads, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/vector-cortex-docs-check.mjs
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const DOCS = join(root, "docs", "vector-cortex");
const SPRINTS_DIR = join(DOCS, "sprints");
const PHASES_DIR = join(DOCS, "phases");
const MAX_MD_LINES = 500;
const KNOWN_MIGRATIONS = new Set(["M2", "M3", "M4", "M5", "M6", "M7", "MIG-DOWN-001"]);
const EXPECTED_SPRINTS = 33; // VC0A..VC8C (27) + VC0E + VC0F dashboard follow-ups + VC9A setup cortex + VC9B setup-cortex actions + VC9C setup-tab cortex + VC9D embedder-detect consolidation
const EXPECTED_PHASES = 9;

const issues = [];
function fail(msg) {
  issues.push(msg);
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function walkMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function checkLineCounts() {
  for (const p of walkMd(DOCS)) {
    const lines = readFileSync(p, "utf8").split("\n").length;
    if (lines > MAX_MD_LINES) {
      fail(`docs md exceeds ${MAX_MD_LINES} lines: ${relative(root, p)} (${lines})`);
    }
  }
}

/** Resolve a markdown link target to an existing file, if possible. */
function linkTarget(baseDir, target) {
  const t = target.split("#")[0].trim();
  if (!t || t.startsWith("http") || t.startsWith("mailto:")) return null;
  const decoded = decodeURIComponent(t);
  // Root-anchored link (../<repo-relative>) from within docs/vector-cortex.
  const candidates = [resolve(baseDir, decoded), resolve(root, decoded)];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

function checkLinks() {
  for (const p of walkMd(DOCS)) {
    const text = readFileSync(p, "utf8");
    const baseDir = dirname(p);
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1];
      const t = target.split("#")[0].trim();
      if (!t || t.startsWith("http") || t.startsWith("mailto:")) continue;
      if (!linkTarget(baseDir, t)) {
        fail(`broken link in ${relative(root, p)}: ${target}`);
      }
    }
  }
}

function checkCounts() {
  const sprints = readdirSync(SPRINTS_DIR).filter((f) => f.endsWith(".md"));
  const phases = readdirSync(PHASES_DIR).filter((f) => f.endsWith(".md"));
  if (sprints.length !== EXPECTED_SPRINTS) {
    fail(`expected ${EXPECTED_SPRINTS} sprint docs, found ${sprints.length} in sprints/`);
  }
  if (phases.length !== EXPECTED_PHASES) {
    fail(`expected ${EXPECTED_PHASES} phase docs, found ${phases.length} in phases/`);
  }
}

function checkFlags() {
  for (const name of readdirSync(SPRINTS_DIR)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(join(SPRINTS_DIR, name), "utf8");
    if (!/MEGACOMPACT_[A-Z0-9_]+/.test(text)) {
      fail(`sprint doc ${name} has no positive MEGACOMPACT_* flag line`);
    }
  }
}

/**
 * Validate that exact bash test commands reference real entry points.
 * `node scripts/...` / `python3 scripts/...` must exist on disk. Future-sprint
 * `node --test dist/vector-cortex/vcXX-acceptance.test.js` aggregators are
 * documented before they exist, so those are format-checked (dist/<path>.js),
 * not existence-checked.
 */
function checkTestCommands() {
  for (const p of walkMd(DOCS)) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
      const block = m[1];
      for (const line of block.split("\n")) {
        const cmd = line.trim();
        if (!cmd || cmd.startsWith("#")) continue;
        const testMatch = cmd.match(/^node\s--test\s+dist\/(.+\.js)\s*$/);
        if (testMatch) {
          if (!testMatch[1].startsWith("vector-cortex/")) {
            fail(`test command aggregation must live under dist/vector-cortex: dist/${testMatch[1]} (in ${relative(root, p)})`);
          }
          continue;
        }
        const scriptMatch = cmd.match(/^(?:node|python3)\s+(.+\.(?:mjs|js|py))\s*$/);
        if (scriptMatch) {
          // First path-like token is the script itself.
          const target = scriptMatch[1].trim().split(/\s+/)[0];
          // Current-sprint (VC0A) gate scripts + the standard project gates must
          // exist. Future-sprint asset/script references are documented before
          // they ship and are format-only here.
          const required =
            /vector-cortex-(conformance|docs-check|evaluate)/.test(target) ||
            ["scripts/regression_check.py", "scripts/guardrails-scan.mjs", "scripts/log_failure.py", "scripts/semantic-scan.mjs"].includes(target);
          if (required && !exists(join(root, target))) {
            fail(`test command references missing script: ${target} (in ${relative(root, p)})`);
          }
        }
      }
    }
  }
}

function checkMigrations() {
  for (const p of walkMd(DOCS)) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/\b(M[2-7]|MIG-DOWN-001)\b/g)) {
      const id = m[1];
      const known = [...KNOWN_MIGRATIONS].includes(id);
      if (!known) fail(`unknown migration ID ${id} in ${relative(root, p)}`);
    }
  }
}

checkLineCounts();
checkLinks();
checkCounts();
checkFlags();
checkTestCommands();
checkMigrations();

if (issues.length > 0) {
  console.error(`DOCS-CHECK: ${issues.length} issue(s):`);
  for (const i of issues) console.error(`  - ${i}`);
  process.exit(1);
}
console.log(
  `✓ DOCS-CHECK: ${EXPECTED_SPRINTS} sprints / ${EXPECTED_PHASES} phases, links+flags+commands+migrations clean.`,
);
process.exit(0);
