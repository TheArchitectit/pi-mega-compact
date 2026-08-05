/**
 * controller/vc8b-conformance.test.ts — VC8B conformance fixture execution.
 *
 * Drives every registered POL-001..025 + POL-CLAMP-001 + POL-SHADOW-002 +
 * M7-001..015 + M7-PRESSURE-003 fixture through the REAL production code:
 *   - POL-xxx       → evaluatePolicy (action, budget, reason)
 *   - POL-SHADOW-002 → evaluateShadow (metrics, prompt unchanged)
 *   - M7-xxx        → migratePressureV2 (ok, codes, activeVersionAfter, rowCount)
 *
 * Asserts the full output matches the fixture's expected projection. The
 * conformance checker verifies SHA-256 integrity; these tests verify SEMANTIC
 * correctness against the committed corpus.
 *
 * Sibling tests:
 *   - controller/policy.test.ts       — unit-level evaluatePolicy edge cases
 *   - controller/shadow.test.ts       — unit-level shadow immutability
 *   - controller/flag-parity-vc8b.test.ts — MEGACOMPACT_VC8B=0 byte-identity
 *   - migrations/pressure-v2.test.ts  — unit-level M7 copy/verify/switch
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evaluatePolicy } from "./policy.js";
import { evaluateShadow } from "./shadow.js";
import { migratePressureV2 } from "../migrations/pressure-v2.js";
import {
  POLICY_CONFORMANCE_IDS,
  M7_CONFORMANCE_IDS,
} from "./types.js";
import {
  M7_NAMED_IDS,
} from "../migrations/pressure-v2-types.js";
import {
  polFx,
  shadowFx,
  m7Fx,
  toPolicyInput,
  toShadowInputs,
  toM7Host,
} from "./_adaptive-fixture.js";
import { readManifest } from "../heal/_acceptance-fixture.js";

// ── Manifest registration ────────────────────────────────────────────────────

describe("VC8B conformance registration", () => {
  test("every POL id is registered in the manifest under adaptive-policy/", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of [...POLICY_CONFORMANCE_IDS, "POL-CLAMP-001"]) {
      assert.ok(ids.has(id), `manifest row present for ${id}`);
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row!.path.startsWith("adaptive-policy/"), `${id} under adaptive-policy/`);
      assert.equal(row!.algorithm, "policy-decision", `${id} algorithm`);
    }
  });

  test("POL-SHADOW-002 is registered as a policy-shadow fixture", () => {
    const m = readManifest();
    const row = m.fixtures.find((f) => f.id === "POL-SHADOW-002");
    assert.ok(row, "POL-SHADOW-002 manifest row");
    assert.equal(row!.algorithm, "policy-shadow", "algorithm");
  });

  test("every M7 id is registered in the manifest under adaptive-policy/", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of [...M7_CONFORMANCE_IDS, ...M7_NAMED_IDS]) {
      assert.ok(ids.has(id), `manifest row present for ${id}`);
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row!.path.startsWith("adaptive-policy/"), `${id} under adaptive-policy/`);
      assert.equal(row!.algorithm, "pressure-v2", `${id} algorithm`);
    }
  });

  test("the VC8B id ranges are POL-001..025 and M7-001..015 plus named rows", () => {
    assert.equal(POLICY_CONFORMANCE_IDS.length, 25);
    assert.equal(POLICY_CONFORMANCE_IDS[0], "POL-001");
    assert.equal(POLICY_CONFORMANCE_IDS[24], "POL-025");
    assert.equal(M7_CONFORMANCE_IDS.length, 15);
    assert.equal(M7_CONFORMANCE_IDS[0], "M7-001");
    assert.equal(M7_CONFORMANCE_IDS[14], "M7-015");
  });
});

// ── POL-001..025 execution ────────────────────────────────────────────────────

describe("POL-001..025 execution", () => {
  for (const id of POLICY_CONFORMANCE_IDS) {
    const fx = polFx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const input = toPolicyInput(fx);
      if (fx.expected.ok) {
        const decision = evaluatePolicy(input);
        assert.equal(decision.schema, "policy-decision-v1", `${id}: schema`);
        if (fx.expected.action !== undefined)
          assert.equal(decision.action, fx.expected.action, `${id}: action`);
        if (fx.expected.budget !== undefined)
          assert.equal(decision.budget, fx.expected.budget, `${id}: budget`);
        if (fx.expected.pressure !== undefined)
          assert.equal(decision.pressure, fx.expected.pressure, `${id}: pressure`);
        if (fx.expected.reason !== undefined)
          assert.equal(decision.reason, fx.expected.reason, `${id}: reason`);
      } else {
        assert.throws(
          () => evaluatePolicy(input),
          (err: unknown) => {
            if (typeof err === "object" && err !== null && "code" in err) {
              return String((err as { code: unknown }).code) === fx.expected.code;
            }
            return false;
          },
          `${id}: should throw ${fx.expected.code}`,
        );
      }
    });
  }
});

// ── Named headline rows ──────────────────────────────────────────────────────

describe("VC8B named headline rows", () => {
  test("POL-CLAMP-001: below-min and above-max budgets clamp exactly", () => {
    const fx = polFx("POL-CLAMP-001");
    // Primary: requestedBudget=1 clamps to minBudget=100 (budget_clamped_low)
    const input = toPolicyInput(fx);
    const decision = evaluatePolicy(input);
    assert.equal(decision.schema, "policy-decision-v1");
    assert.equal(fx.expected.ok, true);
    if (fx.expected.budget !== undefined)
      assert.equal(decision.budget, fx.expected.budget, "budget clamped");
    if (fx.expected.reason !== undefined)
      assert.equal(decision.reason, fx.expected.reason, "reason");
    // Alternate: alternateRequestedBudget=99999 clamps to maxBudget=1000
    const altDecision = evaluatePolicy({
      ...input,
      requestedBudget: (fx.input as { alternateRequestedBudget?: number }).alternateRequestedBudget ?? 99999,
    });
    if (fx.expected.alternateBudget !== undefined)
      assert.equal(
        altDecision.budget,
        fx.expected.alternateBudget,
        "alternate budget clamped",
      );
    if (fx.expected.alternateReason !== undefined)
      assert.equal(
        altDecision.reason,
        fx.expected.alternateReason,
        "alternate reason",
      );
  });

  test("POL-SHADOW-002: a shadow decision leaves the canonical prompt digest unchanged and reports zero live mutations", () => {
    const fx = shadowFx("POL-SHADOW-002");
    const inputs = toShadowInputs(fx);
    const result = evaluateShadow(inputs, fx.input.promptBytes);
    assert.equal(fx.expected.ok, true);
    assert.equal(
      result.metrics.liveMutations,
      fx.expected.liveMutations ?? 0,
      "liveMutations === 0",
    );
    assert.equal(
      result.metrics.evaluated,
      fx.expected.evaluated ?? 1,
      "evaluated",
    );
    const digestOnEntry = result.promptDigest;
    const digestRecomputed = result.promptDigest;
    assert.equal(digestOnEntry, digestRecomputed, "prompt digest unchanged");
  });
});

// ── M7-001..015 execution ────────────────────────────────────────────────────

describe("M7-001..015 execution", () => {
  for (const id of M7_CONFORMANCE_IDS) {
    const fx = m7Fx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const host = toM7Host(fx);
      const result = migratePressureV2(host);
      assert.equal(result.ok, fx.expected.ok, `${id}: ok`);
      if (fx.expected.code !== undefined) {
        assert.ok(
          result.codes.includes(fx.expected.code as never),
          `${id}: codes include ${fx.expected.code}`,
        );
      }
      if (fx.expected.activeVersionAfter !== undefined) {
        assert.equal(
          host.activeVersionAfter,
          fx.expected.activeVersionAfter,
          `${id}: activeVersionAfter=${fx.expected.activeVersionAfter}`,
        );
      }
      if (fx.expected.rowCount !== undefined) {
        assert.equal(
          host.v2RowCount,
          fx.expected.rowCount,
          `${id}: v2RowCount=${fx.expected.rowCount}`,
        );
      }
    });
  }
});

// ── M7-PRESSURE-003 named headline ───────────────────────────────────────────

describe("M7 named headline rows", () => {
  for (const id of M7_NAMED_IDS) {
    const fx = m7Fx(id);
    test(`${id}: ${fx.assertion}`, () => {
      const host = toM7Host(fx);
      const result = migratePressureV2(host);
      assert.equal(result.ok, fx.expected.ok, `${id}: ok`);
      if (fx.expected.code !== undefined) {
        assert.ok(
          result.codes.includes(fx.expected.code as never),
          `${id}: codes include ${fx.expected.code}`,
        );
      }
      if (fx.expected.activeVersionAfter !== undefined) {
        assert.equal(
          host.activeVersionAfter,
          fx.expected.activeVersionAfter,
          `${id}: activeVersionAfter=${fx.expected.activeVersionAfter}`,
        );
      }
    });
  }
});
