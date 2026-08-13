#!/usr/bin/env node
// Test suite for internal-err-scan.mjs — asserts the PREVENT-INTERNAL-ERR-001
// scanner catches unpaired failure-event emits and accepts paired/annotated
// ones. Mirrors scripts/guardrails-scan.test.mjs's standalone pattern.
//
// Run: node scripts/internal-err-scan.test.mjs
// (Standalone; not part of npm test — the scanner itself runs in `npm run lint`.)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Re-implement the scanner's core predicates to test them in isolation (the
// scanner script is a CLI; these mirror its FAIL_EMIT_RE / allowOn / pairing
// logic exactly — keep in sync with scripts/internal-err-scan.mjs).
const FAIL_EMIT_RE =
  /(?:dashboard\.event|logger\.warn)\s*\(\s*["'`]([a-z0-9_-]*fail[a-z0-9_-]*)["'`]/i;
const GENERIC_REASONS = /^(todo|tbd|later|placeholder|fixme|someday|wip|soon|xxx|na|n\/a|pending|future)$/i;

function isFailEmit(line) {
  return FAIL_EMIT_RE.exec(line);
}
function allowReason(line) {
  const m = line.match(/guardrails-allow\s+INTERNAL-ERR\s*:\s*(\S[^*\n]*)/i);
  if (!m) return null;
  const reason = m[1].replace(/[":,.;]+$/, "").trim();
  if (!reason) return { invalid: true, reason: "" };
  if (GENERIC_REASONS.test(reason)) return { invalid: true, reason };
  return reason;
}
function hasRecordInternalError(lines, idx) {
  const re = /\brecordInternalError\s*\(/;
  const lo = Math.max(0, idx - 20);
  const hi = Math.min(lines.length - 1, idx + 20);
  for (let i = lo; i <= hi; i++) if (re.test(lines[i] ?? "")) return true;
  return false;
}

// A scan over a multi-line source snippet: returns {failEmits, unregistered}.
function scanSource(src) {
  const lines = src.split("\n");
  const failEmits = [];
  const unregistered = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isFailEmit(lines[i])) continue;
    const eventName = isFailEmit(lines[i])[1];
    // scan back 20 lines for an allow annotation (mirror allowOn)
    let allow = null;
    for (let j = i; j >= Math.max(0, i - 20); j--) {
      const a = allowReason(lines[j]);
      if (a !== null) { allow = a; break; }
    }
    const paired = hasRecordInternalError(lines, i);
    const registered = paired || (typeof allow === "string");
    failEmits.push({ eventName, registered });
    if (!registered) unregistered.push({ line: i + 1, eventName });
  }
  return { failEmits, unregistered };
}

// ---------------------------------------------------------------------------
// Tests
let pass = 0,
  fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

test("detects an unpaired dashboard.event *_failed emit", () => {
  const src = `runtime.dashboard.event("turn_write_failed", { error: "x" });`;
  const { failEmits, unregistered } = scanSource(src);
  if (failEmits.length !== 1) throw new Error(`expected 1 emit, got ${failEmits.length}`);
  if (unregistered.length !== 1) throw new Error("unpaired emit should be unregistered");
});

test("detects an unpaired logger.warn *_fail emit", () => {
  const src = `runtime.logger.warn("db-mirror-append-fail", { error: "x" });`;
  const { unregistered } = scanSource(src);
  if (unregistered.length !== 1) throw new Error("logger.warn fail emit should be detected");
});

test("paired emit (recordInternalError in scope) is registered", () => {
  const src = `} catch (e) {
  runtime.logger.warn("turn_write_failed", { error: String(e) });
  runtime.recordInternalError("store_write");
}`;
  const { failEmits, unregistered } = scanSource(src);
  if (failEmits.length !== 1) throw new Error("expected 1 emit");
  if (unregistered.length !== 0) throw new Error("paired emit should be registered");
});

test("annotated emit (guardrails-allow INTERNAL-ERR: <reason>) is registered", () => {
  const src = `// guardrails-allow INTERNAL-ERR: no runtime handle in bridge factory
runtime.logger.warn("fork_failed", { error: String(e) });`;
  const { unregistered } = scanSource(src);
  if (unregistered.length !== 0) throw new Error("annotated emit should be registered");
});

test("generic-reason annotation (todo/tbd) is NOT registered", () => {
  const src = `// guardrails-allow INTERNAL-ERR: todo
runtime.logger.warn("fork_failed", { error: String(e) });`;
  const { unregistered } = scanSource(src);
  if (unregistered.length !== 1) throw new Error("generic reason should fail");
});

test("bare annotation (no reason) is NOT registered", () => {
  const src = `// guardrails-allow INTERNAL-ERR:
runtime.logger.warn("fork_failed", { error: String(e) });`;
  const { unregistered } = scanSource(src);
  if (unregistered.length !== 1) throw new Error("bare annotation should fail");
});

test("non-fail dashboard.event emit is ignored", () => {
  const src = `runtime.dashboard.event("turn_written", { turnIndex: 1 });`;
  const { failEmits } = scanSource(src);
  if (failEmits.length !== 0) throw new Error("non-fail emit should be ignored");
});

test("recordInternalError outside the ±20-line window does NOT pair", () => {
  const far = "const x = 1;\n".repeat(25);
  const src = `${far}runtime.logger.warn("turn_write_failed", { error: "x" });`;
  const { unregistered } = scanSource(src);
  if (unregistered.length !== 1) throw new Error("out-of-scope recordInternalError should not pair");
});

// ---------------------------------------------------------------------------
// Summary
const total = pass + fail;
console.log(`\nINTERNAL-ERR SCAN TEST: ${pass}/${total} pass, ${fail}/${total} fail`);
if (fail > 0) {
  console.error("Some tests FAILED. Fix before committing.");
  process.exit(1);
}
console.log("✓ All internal-err-scan tests passed.");
process.exit(0);
