#!/usr/bin/env node
// Node fallback for the guardrails pattern-scan (mirrors scripts/regression_check.py
// PREVENT-PI-* rules) so `npm run lint` works without Python present.
// Loads .guardrails/prevention-rules/pattern-rules.json and scans *.ts under
// extensions/ and src/ for added lines matching any 'critical'/'error' pi rule.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rulesPath = join(root, ".guardrails", "prevention-rules", "pattern-rules.json");

function loadRules() {
  const data = JSON.parse(readFileSync(rulesPath, "utf-8"));
  return data.rules.filter(
    (r) => r.enabled !== false &&
      ["critical", "error"].includes(r.severity) &&
      (r.rule_id || "").startsWith("PREVENT-PI-"),
  );
}

/** Minimal glob matcher (supports * and **). */
function globMatch(glob, path) {
  const re = new RegExp(
    "^" + glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "__(DS__)")        // temp marker for **/
      .replace(/\*\*/g, ".*")
      .replace(/__\(DS__\)/g, ".*")           // restore **/
      .replace(/\*/g, "[^/]*") + "$",
  );
  return re.test(path);
}

function ruleAppliesTo(rule, file) {
  const globs = rule.file_glob;
  if (!Array.isArray(globs) || globs.length === 0) return true;
  // walk() yields absolute paths; globs are repo-relative, so match against
  // the path with the repo root stripped. (Bug fix: absolute paths previously
  // never matched, silently disabling every PREVENT-PI-* rule.)
  const rel = file.startsWith(root + "/") ? file.slice(root.length + 1) : file;
  return globs.some((g) => globMatch(g, rel));
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!["node_modules", "dist", "guardrails-template", ".git"].includes(name)) walk(p, acc);
    } else if (/\.(ts|js)$/.test(name) && !name.endsWith(".d.ts")) {
      acc.push(p);
    }
  }
  return acc;
}

// Dev-only files exempt from PREVENT-PI-004. The dashboard server is an
// OPTIONAL, user-triggered (/dashboard command), localhost-only SSE/HTTP UI
// with zero deps — not a background network call to a remote service. The core
// compaction/vector path (src/**, mega-compact.ts runtime) stays fully covered.
const PI004_EXCLUSIONS = [
  "extensions/dashboard-server.ts",
  "extensions/dashboard-server.test.ts",
  "extensions/DASHBOARD.md",
];

function isExcluded(file) {
  const rel = file.startsWith(root + "/") ? file.slice(root.length + 1) : file;
  return PI004_EXCLUSIONS.includes(rel);
}

function main() {
  const rules = loadRules();
  const files = [...walk(join(root, "extensions")), ...walk(join(root, "src"))];
  let violations = 0;
  for (const file of files) {
    if (isExcluded(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of rules) {
        if (!ruleAppliesTo(rule, file)) continue;
        // Inline allow: `// guardrails-allow PREVENT-PI-004: <reason>` on the
        // same line documents a deliberate, audited exception (e.g. the
        // user-triggered localhost dashboard). Reason text is required.
        const allow = new RegExp(`guardrails-allow\\s+${rule.rule_id}\\s*:\\s*\\S`);
        if (allow.test(line)) continue;
        try {
          if (new RegExp(rule.pattern).test(line)) {
            console.error(`[GUARDRAILS][${rule.severity}] ${rule.rule_id} ${file}:${i + 1} — ${rule.message}`);
            violations++;
          }
        } catch { /* ignore bad regex */ }
      }
    });
  }
  if (violations > 0) {
    console.error(`\nGUARDRAILS: ${violations} violation(s) found.`);
    process.exit(1);
  }
  console.log("GUARDRAILS: pi pattern scan clean.");
}

try { main(); } catch (e) { console.error("guardrails-scan error:", e.message); process.exit(1); }
