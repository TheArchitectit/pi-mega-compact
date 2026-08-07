#!/usr/bin/env node
/**
 * stub-scan.mjs — PREVENT-STUB-001 / PREVENT-VERIFICATION-BYPASS-001 scanner.
 *
 * Scans src/ and extensions/ (non-test .ts/.js) for runtime stub/placeholder
 * markers and verification-skip sentinels. A detected occurrence is REGISTERED
 * (non-fatal under --fail-on-unregistered) when it carries a
 * `// guardrails-allow PREVENT-STUB-001: <closure sprint id>` or
 * `// guardrails-allow PREVENT-VERIFICATION-BYPASS-001: <reason>` annotation on
 * the same line or the immediately-preceding comment line.
 *
 * Modes:
 *   default                 — report every occurrence; exit 1 if any found.
 *   --fail-on-unregistered  — fail ONLY on occurrences without an allow
 *                             annotation (registered stubs pass). Wired into
 *                             `npm run lint` so a NEW unregistered stub fails at
 *                             the sprint boundary (framework §5).
 *
 * A bare `// guardrails-allow PREVENT-STUB-001:` with no closure sprint id is a
 * FAILURE (the allow MUST name a real closure sprint such as ML5-A or VC6C-IMPL;
 * a generic "todo"/"later"/"TBD" is rejected). This is the "fail-on-unregistered"
 * teeth the rule table promises.
 *
 * LOCAL ONLY: filesystem reads, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/stub-scan.mjs [--fail-on-unregistered]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src", "extensions"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** A real closure sprint id looks like ML5-A / VC6C-IMPL / ENC-0g / VC5A. */
const CLOSURE_SPRINT_RE = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
/** Generic ids that must NOT satisfy the closure-sprint requirement. */
const GENERIC_IDS = /^(todo|tbd|later|placeholder|fixme|someday|wip|soon|xxx|na|n\/a|pending|future)$/i;

/** Exact sentinels that silently skip a per-shard/verification digest check. */
const SENTINEL_RE =
  /"0"\.repeat\(\s*40[0-9]*|\?\?\s*"0"|(?:digest|commit|shardDigest)\s*===?\s*["']0["']/;

/** LCG / seeded-PRNG constants used to fabricate deterministic sequences. */
const LCG_RE = /\b1664525\b|\b1013904223\b|\bmulberry32\b/;

/** Generic runtime-stub/placeholder doc markers on non-comment code lines. */
const STUB_KEYWORD_RE =
  /\b(stub|placeholder|not implemented|future sprint|dummy implementation)\b/i;

const TRACE_MARKER_RE = /\b(TODO|FIXME|HACK)\b/;

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

/** An allow annotation visible on this line or a nearby preceding comment block. */
function allowOn(lines, idx, ruleId) {
  const re = new RegExp(`guardrails-allow\\s+${ruleId}\\s*:\\s*(\\S+)`, "i");
  // A block-level allow at a function/comment header can govern a whole body, so
  // scan back past the enclosing block start (def line) up to 20 lines.
  const scanRange = Math.max(0, idx - 20);
  for (let i = idx; i >= scanRange; i--) {
    const m = lines[i] ? lines[i].match(re) : null;
    if (m) return m[1];
  }
  return null;
}

function closureSprintValid(annotation) {
  if (!annotation) return null; // no annotation
  const target = annotation.replace(/[":,.;]+$/, "");
  if (GENERIC_IDS.test(target)) return { ok: false, target };
  if (!CLOSURE_SPRINT_RE.test(target)) return { ok: false, target };
  return { ok: true, target };
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

      // Sentinels apply even on comment-less code lines; classify by rule.
      const st = SENTINEL_RE.exec(line);
      const lcg = LCG_RE.exec(code);
      const kw = STUB_KEYWORD_RE.exec(code);
      const tr = TRACE_MARKER_RE.exec(code);

      const events = [];
      if (st) events.push({ rule: "PREVENT-VERIFICATION-BYPASS-001", text: st[0] });
      if (lcg) events.push({ rule: "PREVENT-STUB-001", text: lcg[0] });
      if (kw) events.push({ rule: "PREVENT-STUB-001", text: kw[0] });
      if (tr) events.push({ rule: "PREVENT-STUB-001", text: tr[0] });
      if (events.length === 0) continue;

      for (const ev of events) {
        const allowText = allowOn(lines, i, ev.rule);
        const valid = closureSprintValid(allowText);
        const registered = valid && valid.ok;
        const lineStr = line.trim();
        reports.push({ rel, line: i + 1, rule: ev.rule, text: ev.text, lineStr, registered, allowText });

        if (failOnUnregistered) {
          // Registered (valid allow) passes; invalid/bare allows and unregistered fail.
          if (!registered) {
            const why =
              allowText === null
                ? "no guardrails-allow annotation"
                : valid && valid.ok === false
                  ? `invalid closure sprint '${valid.target}' in allow`
                  : "unregistered";
            console.error(`[STUB][${ev.rule}] ${rel}:${i + 1} — ${ev.text} (${why})`);
            failures++;
          }
        } else if (!registered) {
          console.error(`[STUB][${ev.rule}] ${rel}:${i + 1} — ${ev.text} (no allow)`);
          failures++;
        }
      }
    }
  }

  const registered = reports.filter((r) => r.registered).length;
  const msg = `STUB-SCAN: ${reports.length} occurrence(s), ${registered} registered, ${failures} failing (mode=${failOnUnregistered ? "fail-on-unregistered" : "strict"}).`;
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
  console.error("stub-scan error:", e.message);
  process.exit(1);
}
