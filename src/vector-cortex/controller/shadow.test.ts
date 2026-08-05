/**
 * controller/shadow.test.ts — VC8B shadow evaluator tests.
 *
 * The shadow contract is a CAPABILITY contract, so these tests check what the
 * module cannot do as much as what it returns: inputs are copied (not
 * borrowed), the canonical prompt digest is unchanged, and the live mutation
 * count is zero. Uses the real production module — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyPolicyInput,
  evaluateShadow,
  isShadowClean,
  promptDigestOf,
} from "./shadow.js";
import { isDecisionWithinBounds, isPolicyAction } from "./policy.js";
import type { PolicyBounds, PolicyInput } from "./types.js";
import { POL_PRESSURE_UNKNOWN, PRESSURE_LEVELS } from "./types.js";

const BOUNDS: PolicyBounds = { minBudget: 100, maxBudget: 1000 };
const PROMPT = "system: be concise\nuser: summarize the vector cortex design";

/** Locate the repo root (the directory holding `conformance/vector-cortex`). */
const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    decisionId: "dec-1",
    sessionId: "sess-1",
    pressure: "low",
    requestedBudget: 500,
    bounds: BOUNDS,
    ts: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("VC8B shadow input copying", () => {
  test("copyPolicyInput returns an equal but distinct object", () => {
    const original = input();
    const copy = copyPolicyInput(original);
    assert.deepEqual(copy, original);
    assert.notEqual(copy, original, "the copy is a different object");
    assert.notEqual(copy.bounds, original.bounds, "bounds are copied too");
  });

  test("mutating the copy's bounds cannot reach the original", () => {
    const original = input();
    const copy = copyPolicyInput(original) as { bounds: { minBudget: number } };
    copy.bounds.minBudget = 99_999;
    assert.equal(original.bounds.minBudget, 100, "the original is untouched");
  });

  test("evaluateShadow does not mutate the caller's inputs", () => {
    const inputs = [
      input({ decisionId: "d1", pressure: "high", requestedBudget: 900 }),
      input({ decisionId: "d2", pressure: "mega", requestedBudget: 50 }),
    ];
    const snapshot = JSON.stringify(inputs);
    evaluateShadow(inputs, PROMPT);
    assert.equal(JSON.stringify(inputs), snapshot, "inputs are byte-identical");
  });

  test("evaluateShadow does not mutate the caller's input ARRAY", () => {
    const inputs = [input({ decisionId: "d1" }), input({ decisionId: "d2" })];
    evaluateShadow(inputs, PROMPT);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].decisionId, "d1");
  });
});

describe("VC8B shadow prompt immutability", () => {
  test("POL-SHADOW-002: decision leaves canonical prompt digest unchanged", () => {
    const before = promptDigestOf(PROMPT);
    const result = evaluateShadow([input()], PROMPT);
    const after = promptDigestOf(PROMPT);
    assert.equal(before, after, "the prompt bytes did not move");
    assert.equal(result.promptDigest, before, "the reported digest matches");
  });

  test("the prompt digest is unchanged even when every input rejects", () => {
    const before = promptDigestOf(PROMPT);
    const result = evaluateShadow(
      [input({ pressure: "bogus" }), input({ pressure: "also-bogus" })],
      PROMPT,
    );
    assert.equal(result.promptDigest, before);
    assert.equal(result.metrics.liveMutations, 0);
  });

  test("the reported digest is a real SHA-256 of the prompt bytes", () => {
    const result = evaluateShadow([input()], PROMPT);
    assert.match(result.promptDigest, /^[0-9a-f]{64}$/, "bare lowercase hex");
    assert.equal(result.promptDigest, promptDigestOf(PROMPT));
  });

  test("different prompts produce different digests", () => {
    const a = evaluateShadow([input()], "prompt A").promptDigest;
    const b = evaluateShadow([input()], "prompt B").promptDigest;
    assert.notEqual(a, b);
  });
});

describe("VC8B shadow has no live capability", () => {
  test("live mutation count is zero for every canonical pressure", () => {
    for (const pressure of PRESSURE_LEVELS) {
      const result = evaluateShadow([input({ pressure })], PROMPT);
      assert.equal(result.metrics.liveMutations, 0, `${pressure} mutated nothing`);
      assert.ok(isShadowClean(result));
    }
  });

  test("the shadow module imports no renderer, store writer, or prompt mutator", (t) => {
    // A capability contract is only real if it is enforced against the source:
    // a future edit that imports a writer would pass every behavioural test
    // above while silently breaking the contract.
    const root = repoRoot(HERE);
    const sourcePath =
      root === null ? null : join(root, "src", "vector-cortex", "controller", "shadow.ts");
    if (sourcePath === null || !existsSync(sourcePath)) {
      // Published dist offset: the .ts source is not shipped, so the static
      // check cannot run there. It still runs on every in-repo gate.
      t.skip("shadow.ts source not present at this offset");
      return;
    }
    const source = readFileSync(sourcePath, "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map(
      (m) => m[1],
    );
    for (const specifier of imports) {
      assert.ok(
        !/render|store|writer|persist|sqlite|vector-store/i.test(specifier),
        `shadow.ts must not import ${specifier}`,
      );
    }
    assert.deepEqual(
      imports.sort(),
      ["./policy.js", "./types.js", "node:crypto"],
      "shadow.ts imports exactly crypto + its own policy/types",
    );
  });

  test("the result exposes decisions and metrics ONLY", () => {
    const result = evaluateShadow([input()], PROMPT);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["decisions", "metrics", "promptDigest", "rejections"],
      "no writer handle, no rendered bytes, no prompt text",
    );
  });

  test("the result never carries the prompt bytes themselves", () => {
    const result = evaluateShadow([input()], PROMPT);
    const json = JSON.stringify(result);
    assert.ok(!json.includes("summarize"), "prompt text never leaks");
    assert.ok(!json.includes("be concise"), "prompt text never leaks");
  });
});

describe("VC8B shadow decisions and metrics", () => {
  test("every decision is an allowed action with a bounded budget", () => {
    const inputs = PRESSURE_LEVELS.map((pressure, i) =>
      input({ decisionId: `d${i}`, pressure, requestedBudget: i * 700 }),
    );
    const result = evaluateShadow(inputs, PROMPT);
    assert.equal(result.decisions.length, PRESSURE_LEVELS.length);
    for (const decision of result.decisions) {
      assert.ok(isPolicyAction(decision.action));
      assert.ok(isDecisionWithinBounds(decision, BOUNDS));
    }
  });

  test("metrics count evaluated, clamped, and rejected rows", () => {
    const result = evaluateShadow(
      [
        input({ decisionId: "d1", requestedBudget: 500 }), // in-window
        input({ decisionId: "d2", requestedBudget: 9999 }), // clamped high
        input({ decisionId: "d3", pressure: "nope" }), // rejected
      ],
      PROMPT,
    );
    assert.equal(result.metrics.evaluated, 2);
    assert.equal(result.metrics.clamped, 1);
    assert.equal(result.metrics.rejected, 1);
  });

  test("an unknown pressure is recorded as a rejection code, not a throw", () => {
    const result = evaluateShadow([input({ decisionId: "bad", pressure: "x" })], PROMPT);
    assert.equal(result.decisions.length, 0);
    assert.deepEqual(result.rejections, [
      { decisionId: "bad", code: POL_PRESSURE_UNKNOWN },
    ]);
  });

  test("one bad row does not blind the rest of the run", () => {
    const result = evaluateShadow(
      [
        input({ decisionId: "good-1" }),
        input({ decisionId: "bad", pressure: "???" }),
        input({ decisionId: "good-2" }),
      ],
      PROMPT,
    );
    assert.deepEqual(
      result.decisions.map((d) => d.decisionId),
      ["good-1", "good-2"],
      "measurement continues past the rejection",
    );
    assert.equal(result.metrics.rejected, 1);
  });

  test("an empty batch is a clean no-op", () => {
    const result = evaluateShadow([], PROMPT);
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.rejections, []);
    assert.equal(result.metrics.evaluated, 0);
    assert.equal(result.metrics.liveMutations, 0);
  });

  test("shadow decisions match a direct policy evaluation (no drift)", () => {
    const one = input({ pressure: "high", requestedBudget: 800 });
    const result = evaluateShadow([one], PROMPT);
    assert.equal(result.decisions.length, 1);
    // The shadow must not be a second implementation of the policy.
    assert.equal(result.decisions[0].budget, 600);
    assert.equal(result.decisions[0].action, "dampen");
  });

  test("evaluation is deterministic across repeated runs", () => {
    const inputs = [input({ pressure: "ultra", requestedBudget: 777 })];
    const a = evaluateShadow(inputs, PROMPT);
    const b = evaluateShadow(inputs, PROMPT);
    assert.deepEqual(a, b);
  });
});
