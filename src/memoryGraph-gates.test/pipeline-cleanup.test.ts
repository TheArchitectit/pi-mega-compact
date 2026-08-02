/**
 * pipeline-cleanup.test.ts — runValidationPipeline integration + temp-dir cleanup.
 * Split from src/memoryGraph-gates.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { runValidationPipeline } from "../memoryGraph/gates.js";
import { n, e, ws, baseTmp } from "./_helpers.js";

test("runValidationPipeline: runs all 9 gates and returns correct stats shape", () => {
  const set = ws([n("a"), n("b")], [e("a", "b")]);
  const { ws: result, stats } = runValidationPipeline(set);
  assert.equal(stats.gatesRun.length, 9, "all 9 gates should run");
  assert.equal(stats.gatesRun.length, stats.gatesPassed.length, "all gates should pass with clean data");
  assert.equal(result.nodes.length, 2, "both nodes remain");
  assert.equal(result.edges.length, 1, "edge remains");
  assert.equal(stats.dropped.nodes, 0, "no nodes dropped");
  assert.equal(stats.dropped.edges, 0, "no edges dropped");
  assert.ok(Array.isArray(stats.warnings), "warnings is an array");
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
