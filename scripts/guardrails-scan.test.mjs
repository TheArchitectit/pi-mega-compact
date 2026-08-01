#!/usr/bin/env node
// Test suite for guardrails-scan.mjs — asserts the PREVENT-PI-004 network-call
// pattern matcher catches all known dangerous imports and calls, and that the
// guardrails-allow annotation still suppresses them.
//
// Run: node scripts/guardrails-scan.test.mjs
// (Standalone; does not require npm test.)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Re-use the scanner's own pattern loader + matcher by loading the rule JSON.
const rules = JSON.parse(
  readFileSync(
    join(root, ".guardrails", "prevention-rules", "pattern-rules.json"),
    "utf-8",
  ),
);

const PI004 = rules.rules.find((r) => r.rule_id === "PREVENT-PI-004");
if (!PI004) {
  console.error("FATAL: PREVENT-PI-004 rule not found in pattern-rules.json");
  process.exit(1);
}

const CRITICAL = new RegExp(PI004.pattern);

/** Scan a single line against the pattern, respecting the allow annotation. */
function scanLine(line, ruleId = "PREVENT-PI-004") {
  const allow = new RegExp(`guardrails-allow\\s+${ruleId}\\s*:\\s*\\S`);
  if (allow.test(line)) return false;
  return CRITICAL.test(line);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}`);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ---- Existing patterns still work ----

test("catches fetch(...)", () => {
  assert(scanLine('const r = await fetch("https://evil.com/api");'));
});

test("catches http.get(", () => {
  assert(scanLine('http.get("http://evil.com", (res) => {});'));
});

test("catches https.request(", () => {
  assert(scanLine('https.request(options, (res) => {});'));
});

test("catches new WebSocket(", () => {
  assert(scanLine('const ws = new WebSocket("wss://evil.com");'));
});

test("catches XMLHttpRequest", () => {
  assert(scanLine("const x = new XMLHttpRequest();"));
});

test("catches child_process.spawn", () => {
  assert(scanLine('child_process.spawn("node", ["script.js"]);'));
});

// ---- New patterns (PR#11 P0d) ----

test("catches import from undici", () => {
  assert(scanLine("import { request } from 'undici';"));
});

test("catches require(undici)", () => {
  assert(scanLine("const undici = require('undici');"));
});

test("catches net.connect(", () => {
  assert(scanLine("net.connect(8080, 'evil.com');"));
});

test("catches net.createConnection(", () => {
  assert(scanLine("net.createConnection({ port: 8080 });"));
});

test("catches new Agent(", () => {
  assert(scanLine("const a = new Agent({ keepAlive: true });"));
});

test("catches new http.Agent(", () => {
  assert(scanLine("const a = new http.Agent({ keepAlive: true });"));
});

test("catches new https.Agent(", () => {
  assert(scanLine("const a = new https.Agent({ keepAlive: true });"));
});

test("catches require('node:http')", () => {
  assert(scanLine("const http = require('node:http');"));
});

test("catches require('node:https')", () => {
  assert(scanLine("const https = require('node:https');"));
});

test("catches require('node:net')", () => {
  assert(scanLine("const net = require('node:net');"));
});

test("catches import from 'node:http'", () => {
  assert(scanLine("import { createServer } from 'node:http';"));
});

test("catches import from 'node:https'", () => {
  assert(scanLine("import { request } from 'node:https';"));
});

test("catches import from 'node:net'", () => {
  assert(scanLine("import { connect } from 'node:net';"));
});

test("catches import from \"node:http\" (double quotes)", () => {
  assert(scanLine('import { createServer } from "node:http";'));
});

test("catches import from \"node:https\" (double quotes)", () => {
  assert(scanLine('import { request } from "node:https";'));
});

test("catches import from \"node:net\" (double quotes)", () => {
  assert(scanLine('import { connect } from "node:net";'));
});

test("catches createServer(", () => {
  assert(scanLine("const s = createServer((req, res) => { ... });"));
});

// ---- guardrails-allow annotation suppresses ----

test("allow annotation suppresses fetch", () => {
  assert(
    !scanLine(
      'const r = await fetch("http://localhost:9320"); // guardrails-allow PREVENT-PI-004: test-only loopback probe',
    ),
  );
});

test("allow annotation suppresses undici", () => {
  assert(
    !scanLine(
      "import { request } from 'undici'; // guardrails-allow PREVENT-PI-004: undici needed for test helper",
    ),
  );
});

test("allow annotation suppresses net.connect", () => {
  assert(
    !scanLine(
      "net.connect(8080, '127.0.0.1'); // guardrails-allow PREVENT-PI-004: test-only loopback",
    ),
  );
});

test("allow annotation suppresses new Agent", () => {
  assert(
    !scanLine(
      "const a = new Agent({}); // guardrails-allow PREVENT-PI-004: agent for loopback test server",
    ),
  );
});

test("allow annotation suppresses node:http import", () => {
  assert(
    !scanLine(
      "import { createServer } from 'node:http'; // guardrails-allow PREVENT-PI-004: localhost dashboard server",
    ),
  );
});

// ---- False-negative checks (safe patterns must NOT trigger) ----

test("does NOT flag http inside a template literal string declaration", () => {
  // Template literal content is still real code (the scanner works line-by-line),
  // but a String.raw backtick line containing createServer should be caught
  // since it *is* network code in template literal form. This test verifies
  // the scanner catches it (which is correct — test infra that forks child
  // processes needs an annotation).
  assert(
    scanLine("const s = createServer((req, res) => {"),
    "template literals with createServer must be annotated",
  );
});

test("allow annotation works inside template literal", () => {
  assert(
    !scanLine(
      "const s = createServer((req, res) => { // guardrails-allow PREVENT-PI-004: template literal for spawned helper",
    ),
  );
});

// ---- Summary ----

const total = pass + fail;
console.log(`\nGUARDRAILS SCAN TEST: ${pass}/${total} pass, ${fail}/${total} fail`);
if (fail > 0) {
  console.error("Some tests FAILED. Fix before committing.");
  process.exit(1);
}
