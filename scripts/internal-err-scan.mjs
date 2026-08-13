#!/usr/bin/env node
/**
 * internal-err-scan.mjs — PREVENT-INTERNAL-ERR-001 scanner (Sprint H backstop).
 *
 * Scans src/ and extensions/ (non-test .ts/.js) for internal store/service
 * failure-event emits (`*_failed` / `*_fail` event names emitted via
 * `dashboard.event(` or `logger.warn(`) and requires each to be PAIRED with a
 * `recordInternalError(` call in scope (same file, within 20 lines) OR carry a
 * `// guardrails-allow INTERNAL-ERR: <reason>` annotation.
 *
 * This is the no-corners backstop for Sprint H (Finding 3): `errorRate` read
 * 1.0 while 557 `turn_write_failed` events logged because internal store-write
 * failures never reached the health ring. The ring is populated by explicit
 * `recordInternalError(category)` calls AT each emit site (Option A). This
 * scanner makes a FUTURE emit site that forgets the pairing fail the gate —
 * the blind spot can't silently reappear.
 *
 * Modes:
 *   default                 — report every unpaired occurrence; exit 1 if any.
 *   --fail-on-unregistered  — same (fail on unpaired). Wired into `npm run lint`.
 *
 * The allow annotation MUST carry a non-empty reason (not a generic
 * todo/tbd/later) — same teeth as stub-scan. Sites without a `runtime` handle
 * (e.g. the bridge factory, the embedding cache, schema migrations) use the
 * annotation because they cannot call `recordInternalError` directly.
 *
 * LOCAL ONLY: filesystem reads, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/internal-err-scan.mjs [--fail-on-unregistered]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src", "extensions"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** A reason must be non-empty and not a generic placeholder. */
const GENERIC_REASONS = /^(todo|tbd|later|placeholder|fixme|someday|wip|soon|xxx|na|n\/a|pending|future)$/i;

/**
 * A failure-event emit: `dashboard.event("...fail...")` or
 * `logger.warn("...fail...")`. Matches any event name containing "fail"
 * (turn_write_failed, db-mirror-append-fail, wiki_rebuild_failed, etc.).
 * Future `*_failed` emits are automatically covered — no curated list to drift.
 */
const FAIL_EMIT_RE =
  /(?:dashboard\.event|logger\.warn)\s*\(\s*["'`]([a-z0-9_-]*fail[a-z0-9_-]*)["'`]/i;

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

/**
 * A `// guardrails-allow INTERNAL-ERR: <reason>` annotation visible on this line
 * or a nearby preceding comment block (scan back up to 20 lines, mirroring
 * stub-scan). Returns the reason string if valid, null if absent, or
 * { invalid: true, reason } if the reason is a generic placeholder.
 */
function allowOn(lines, idx) {
  const re = /guardrails-allow\s+INTERNAL-ERR\s*:\s*(\S[^*\n]*)/i;
  const scanRange = Math.max(0, idx - 20);
  for (let i = idx; i >= scanRange; i--) {
    const m = lines[i] ? lines[i].match(re) : null;
    if (m) {
      const reason = m[1].replace(/[":,.;]+$/, "").trim();
      if (!reason) return { invalid: true, reason: "" };
      if (GENERIC_REASONS.test(reason)) return { invalid: true, reason };
      return reason;
    }
  }
  return null;
}

/**
 * Is there a `recordInternalError(` call within ±20 lines of `idx` (same file)?
 * The pairing call usually sits in the same catch block as the emit.
 */
function pairedRecordInternalError(lines, idx) {
  const re = /\brecordInternalError\s*\(/;
  const lo = Math.max(0, idx - 20);
  const hi = Math.min(lines.length - 1, idx + 20);
  for (let i = lo; i <= hi; i++) {
    if (re.test(lines[i] ?? "")) return true;
  }
  return false;
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
      if (isCommentOnly(line)) continue;
      const m = FAIL_EMIT_RE.exec(line);
      if (!m) continue;

      const eventName = m[1];
      const paired = pairedRecordInternalError(lines, i);
      const allow = allowOn(lines, i);
      const registered = paired || (allow && typeof allow === "string");
      const lineStr = line.trim();

      reports.push({ rel, line: i + 1, eventName, lineStr, registered, paired, allow });

      if (!registered) {
        const why =
          allow === null
            ? paired
              ? null // paired → registered, won't reach here
              : "no recordInternalError call in scope and no guardrails-allow INTERNAL-ERR annotation"
            : allow && allow.invalid
              ? `invalid INTERNAL-ERR allow reason '${allow.reason}'`
              : "unregistered";
        if (why) {
          console.error(
            `[INTERNAL-ERR][PREVENT-INTERNAL-ERR-001] ${rel}:${i + 1} — ${eventName} (${why})`,
          );
          failures++;
        }
      }
    }
  }

  const registered = reports.filter((r) => r.registered).length;
  const msg = `INTERNAL-ERR-SCAN: ${reports.length} occurrence(s), ${registered} registered, ${failures} failing (mode=${failOnUnregistered ? "fail-on-unregistered" : "strict"}).`;
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
  console.error("internal-err-scan error:", e.message);
  process.exit(1);
}
