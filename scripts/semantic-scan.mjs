#!/usr/bin/env node
// Semantic/AST-based guardrails scanner.
// Enforces SEMANTIC-001: detects Promise.then() chains that lack a .catch()
// handler (unhandled promise rejection). Uses the TypeScript compiler API to
// parse .ts files under extensions/ and src/ (excluding .d.ts and .test.ts).
//
// Supports inline allow: // guardrails-allow SEMANTIC-001: <reason>
//
// This scanner checks ALL source files (not just diffs), complementing the
// diff-based pattern checks in scripts/regression_check.py.

import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── File discovery ──────────────────────────────────────────────────────────

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!["node_modules", "dist", "guardrails-template", ".git", ".crew"].includes(name)) {
        walk(p, acc);
      }
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
      acc.push(p);
    }
  }
  return acc;
}

function collectFiles() {
  return [...walk(join(root, "extensions")), ...walk(join(root, "src"))];
}

// ── Allow-annotation parsing ───────────────────────────────────────────────

function loadAllowLines(sourceText) {
  const allowMap = new Map(); // lineNumber → reason
  const lines = sourceText.split("\n");
  const re = /guardrails-allow\s+SEMANTIC-001\s*:\s*(.+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      allowMap.set(i + 1, m[1].trim()); // 1-indexed
    }
  }
  return allowMap;
}

// ── SEMANTIC-001: .then() without .catch() ────────────────────────────────

/**
 * For a `.then()` CallExpression, walk up the parent chain to determine if
 * the chain eventually includes a `.catch()` handler or is inside an `await`
 * expression (which handles rejections via async/await semantics).
 *
 * Returns true if the promise chain is "caught", false if it's unhandled.
 */
function isChainHandled(thenCall) {
  let current = thenCall;

  while (true) {
    const parent = current.parent;
    if (!parent) return false;

    if (ts.isPropertyAccessExpression(parent)) {
      const propName = parent.name.text;

      if (propName === "catch") {
        return true; // Found .catch() in the chain — handled.
      }

      if (propName === "then" || propName === "finally") {
        // The parent PropertyAccessExpression should be the callee of another
        // CallExpression (i.e., this is a chained call). Continue from that call.
        const grand = parent.parent;
        if (grand && ts.isCallExpression(grand)) {
          current = grand;
          continue;
        }
        // Property accessed but not called — chain is dead-ended.
        return false;
      }

      // Some other property access — chain is broken here.
      return false;
    }

    if (ts.isAwaitExpression(parent)) {
      // `await promise.then(...)` — the await handles rejections.
      return true;
    }

    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }

    // Any other parent type (ExpressionStatement, VariableDeclaration,
    // BinaryExpression, argument in another call, etc.) — chain ended
    // without a .catch() or await.
    return false;
  }
}

/**
 * Find all `.then()` call expressions in the AST and report those whose
 * chain lacks a `.catch()` handler and is not inside an `await`.
 *
 * Also counts `.then(onFulfilled, onRejected)` (two-arg form) as handled.
 */
function findUnhandledThenCalls(sourceFile) {
  const violations = [];

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propName = node.expression.name.text;

      if (propName === "then") {
        // Two-argument form: .then(onFulfilled, onRejected) — rejection handled.
        if (node.arguments.length >= 2) {
          ts.forEachChild(node, visit);
          return;
        }

        // Check if the chain is handled (has .catch or is inside await).
        if (!isChainHandled(node)) {
          const lineNum = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push({
            line: lineNum,
            message: "Promise chain missing .catch() handler",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const files = collectFiles();
  let totalViolations = 0;
  const allViolations = [];

  for (const file of files) {
    const sourceText = readFileSync(file, "utf-8");
    const relFile = file.startsWith(root + "/") ? file.slice(root.length + 1) : file;

    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true, // setParentNodes — required for walking up the chain
      ts.ScriptKind.TS,
    );

    const allowLines = loadAllowLines(sourceText);
    const violations = findUnhandledThenCalls(sourceFile);

    const reportedLines = new Set(); // deduplicate by line (multi-.then chains)
    for (const v of violations) {
      if (reportedLines.has(v.line)) continue;
      const reason = allowLines.get(v.line);
      if (reason) {
        // Suppressed via inline annotation.
        reportedLines.add(v.line);
        continue;
      }

      // Also check if the line above has a guardrails-allow annotation
      // (some projects place it on the preceding line).
      const prevReason = allowLines.get(v.line - 1);
      if (prevReason) {
        reportedLines.add(v.line);
        continue;
      }

      reportedLines.add(v.line);
      console.error(
        `[GUARDRAILS][SEMANTIC-001] ${relFile}:${v.line} — ${v.message}. ` +
          `Add .catch() handler, use try/catch with async/await, ` +
          `or annotate with // guardrails-allow SEMANTIC-001: <reason>`,
      );
      totalViolations++;
      allViolations.push({ file: relFile, line: v.line });
    }
  }

  if (totalViolations > 0) {
    console.error(`\nGUARDRAILS: ${totalViolations} SEMANTIC-001 violation(s) found.`);
    process.exit(1);
  }

  console.log("GUARDRAILS: semantic scan clean (SEMANTIC-001).");
}

try {
  main();
} catch (e) {
  console.error("semantic-scan error:", e.message);
  process.exit(1);
}
