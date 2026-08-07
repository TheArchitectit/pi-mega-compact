/**
 * vector-cortex/encoder/qualify.test.ts — pure-fn unit tests for qualifyEncodedAsset.
 *
 * Each gate fires in isolation; an all-green bench qualifies; a multi-reason
 * bench accumulates reasons; a gated-off bench with sub-threshold p95 still
 * fails. Thresholds are sourced from types.ts constants — never hardcoded.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BenchResultV1, BenchGatesV1 } from "./bench-export.js";
import {
  ENCODER_LATENCY_P95_MS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_OPSET,
} from "./types.js";
import { qualifyEncodedAsset } from "./qualify.js";

const MIB = 1024 * 1024;

function greenGates(): BenchGatesV1 {
  return { latency: true, rss: true, opset: true, determinism: true, all: true };
}

function redGates(): BenchGatesV1 {
  return { latency: false, rss: false, opset: false, determinism: false, all: false };
}

function makeBench(overrides: Partial<BenchResultV1> = {}): BenchResultV1 {
  return {
    timestamp: 0,
    platform: "linux-x64",
    encoderNative: false,
    threads: 4,
    tokens: 512,
    corpusTokens: 1_000_000,
    p95Ms: ENCODER_LATENCY_P95_MS - 1,
    rssMib: 100,
    rssBaselineMib: 50,
    rssMarginalMib: 50,
    opset: ENCODER_OPSET,
    deterministic: true,
    digest: "a".repeat(64),
    gates: greenGates(),
    ...overrides,
  };
}

describe("qualifyEncodedAsset", () => {
  it("qualifies when all gates pass", () => {
    const q = qualifyEncodedAsset(makeBench(), "linux-x64");
    assert.equal(q.verdict, "qualified");
    assert.deepEqual(q.reasons, []);
    assert.equal(q.schema, "qualification-v1");
  });

  it("fails on latency gate only", () => {
    const bench = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS + 1,
      gates: { ...greenGates(), latency: false, all: false },
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("latency"));
    assert.equal(q.reasons.length, 2); // latency + bench_gates_not_green
  });

  it("fails on rss gate only", () => {
    const bench = makeBench({
      rssMarginalMib: Math.floor(ENCODER_RSS_BUDGET_BYTES / MIB) + 1,
      gates: { ...greenGates(), rss: false, all: false },
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("rss"));
  });

  it("fails on determinism gate only", () => {
    const bench = makeBench({
      deterministic: false,
      gates: { ...greenGates(), determinism: false, all: false },
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("determinism"));
  });

  it("fails on opset gate only", () => {
    const bench = makeBench({
      opset: ENCODER_OPSET + 1,
      gates: { ...greenGates(), opset: false, all: false },
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("opset"));
  });

  it("fails with multiple reasons (latency + rss)", () => {
    const bench = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS + 10,
      rssMarginalMib: Math.floor(ENCODER_RSS_BUDGET_BYTES / MIB) + 10,
      gates: { ...greenGates(), latency: false, rss: false, all: false },
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("latency"));
    assert.ok(q.reasons.includes("rss"));
  });

  it("fails when bench gates are not green even with sub-threshold p95", () => {
    const bench = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS - 5,
      rssMarginalMib: 10,
      gates: redGates(),
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    // A gated-off bench can never be swept into mode A by its sub-threshold
    // p95 alone: bench_gates_not_green is the sole forcing reason here (the
    // fixture keeps deterministic:true, so no determinism reason fires).
    assert.deepEqual(q.reasons, ["bench_gates_not_green"]);
  });

  it("does not duplicate bench_gates_not_green reason", () => {
    const bench = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS + 1,
      gates: { ...greenGates(), latency: false, all: false },
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    const count = q.reasons.filter((r) => r === "bench_gates_not_green").length;
    assert.equal(count, 1);
  });

  it("thresholds are sourced from types constants (not hardcoded)", () => {
    // Just above threshold → fail
    const above = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS + 0.001,
      gates: { ...greenGates(), latency: false, all: false },
    });
    assert.equal(qualifyEncodedAsset(above, "linux-x64").verdict, "failed");

    // Just below threshold → pass (if all other gates green)
    const below = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS - 0.001,
    });
    assert.equal(qualifyEncodedAsset(below, "linux-x64").verdict, "qualified");
  });

  it("carries platform, p95Ms, rssMib, opset, digest from bench", () => {
    const bench = makeBench({
      p95Ms: 25.5,
      rssMarginalMib: 42,
      opset: ENCODER_OPSET,
      digest: "deadbeef".repeat(8),
    });
    const q = qualifyEncodedAsset(bench, "darwin-arm64");
    assert.equal(q.platform, "darwin-arm64");
    assert.equal(q.p95Ms, 25.5);
    assert.equal(q.rssMib, 42);
    assert.equal(q.opset, ENCODER_OPSET);
    assert.equal(q.digest, "deadbeef".repeat(8));
  });

  it("handles null p95/rss/opset/digest from degraded bench", () => {
    const bench = makeBench({
      p95Ms: null,
      rssMarginalMib: null,
      opset: null,
      digest: null,
      deterministic: false,
      gates: redGates(),
    });
    const q = qualifyEncodedAsset(bench, "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("determinism"));
    assert.ok(q.reasons.includes("bench_gates_not_green"));
    assert.equal(q.p95Ms, 0);
    assert.equal(q.rssMib, 0);
    assert.equal(q.opset, 0);
    assert.equal(q.digest, "");
  });
});
