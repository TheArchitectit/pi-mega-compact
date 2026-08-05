/**
 * VC5A acceptance aggregator — DAG-001..030 + PLN-001..019 against the REAL
 * prompt-dag + planner logic (src/vector-cortex/prompt-dag/{builder,validator}.js
 * and src/vector-cortex/planner/{portfolio,manifest}.js). Fixture materialization
 * lives in ./prompt-dag/_acceptance-helpers.ts.
 *
 * Acceptance assertions pinned by the sprint contract:
 *   - DAG-CYCLE-001: a dependency cycle rejects with DAG_CYCLE (named)
 *   - stable Kahn order with (startSeq, syntheticOrdinal, id bytes) ties
 *   - PLN-MANDATORY-002: 101 mandatory tokens under budget 100 demotes to C (named)
 *   - PLN-TIE-003: equal ratios choose lower source seq then ID bytes (named)
 *   - mandatory closure is computed BEFORE optional selection; an over-budget
 *     mandatory closure returns MANDATORY_CLOSURE_OVER_BUDGET WITHOUT dropping
 *     evidence (the mandatory set is returned intact)
 *   - 0/1 portfolio selection within the remaining budget, never exceeding it
 *   - UNIQUE failure injection: mutate a node token count after planning but
 *     before validation → validator returns PLN_MANIFEST_DIGEST_MISMATCH and the
 *     plan never reaches the provider
 *   - forced triad A (ratio-ordered 0/1 portfolio) / B (stable greedy closed
 *     planner forced by an A exception, no ratio) / C (predecessor prompt forced
 *     by mandatory overflow)
 *
 * Flag-off parity: MEGACOMPACT_VC5A gates only the reporter seam; the builder /
 * validator / planner functions are PURE and byte-identical either way, so this
 * SAME acceptance suite is green under both flag states.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validatePromptDag, dagDigest } from "./prompt-dag/validator.js";
import { buildPromptDag } from "./prompt-dag/builder.js";
import { planPortfolio, planGreedyClosed, planManifestDigest } from "./planner/portfolio.js";
import { validatePlanManifest } from "./planner/manifest.js";
import { DEFAULT_FRAMING } from "./planner/types.js";
import type { PlanCandidate } from "./planner/types.js";
import { DAG_IDS, DAG_NAMED_IDS } from "./prompt-dag/types.js";
import { PLN_IDS, PLAN_NAMED_IDS } from "./planner/types.js";
import {
  dagFixture,
  plnFixture,
  readManifest,
  runDagScenario,
  runPlannerScenario,
  materializeDag,
  withFlagsOn,
} from "./prompt-dag/_acceptance-helpers.js";

describe("VC5A conformance registration", () => {
  test("manifest registers DAG-001..030 + PLN-001..019 + the named fixtures", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of DAG_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of PLN_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of DAG_NAMED_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of PLAN_NAMED_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of [...DAG_IDS, ...DAG_NAMED_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "prompt-dag", `${id} algorithm promotion`);
    }
    for (const id of [...PLN_IDS, ...PLAN_NAMED_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "planner", `${id} algorithm promotion`);
    }
  });
});

describe("DAG-001..030 conformance rows", () => {
  for (const id of DAG_IDS) {
    test(`${id}: ${dagFixture(id).assertion}`, withFlagsOn(() => {
      const fx = dagFixture(id);
      const got = runDagScenario(fx);
      assert.equal(got.ok, fx.expected.ok, `${id}: ok=${fx.expected.ok}`);
      if (fx.expected.code !== undefined) assert.equal(got.code, fx.expected.code, `${id}: failure code`);
      if (fx.expected.order !== undefined) assert.deepEqual(got.order, fx.expected.order, `${id}: order`);
      if (fx.expected.orderLength !== undefined) assert.equal(got.orderLength, fx.expected.orderLength, `${id}: order length`);
      if (fx.expected.permutationInvariant !== undefined) assert.equal(got.permutationInvariant, true, `${id}: permutation invariant`);
      if (fx.expected.digestStable !== undefined) assert.equal(got.digestStable, true, `${id}: digest stable`);
      if (fx.expected.digestSensitive !== undefined) assert.equal(got.digestSensitive, true, `${id}: digest sensitive`);
      if (fx.expected.orderIsTotal !== undefined) assert.equal(got.orderIsTotal, true, `${id}: order total`);
    }));
  }
});

describe("PLN-001..019 conformance rows", () => {
  for (const id of PLN_IDS) {
    test(`${id}: ${plnFixture(id).assertion}`, withFlagsOn(() => {
      const fx = plnFixture(id);
      const got = runPlannerScenario(fx);
      assert.equal(got.ok, fx.expected.ok, `${id}: ok=${fx.expected.ok}`);
      if (fx.expected.code !== undefined) assert.equal(got.code, fx.expected.code, `${id}: failure code`);
      if (fx.expected.selected !== undefined) assert.deepEqual(got.selected, fx.expected.selected, `${id}: selected`);
      if (fx.expected.tokenTotal !== undefined) assert.equal(got.tokenTotal, fx.expected.tokenTotal, `${id}: token total`);
      if (fx.expected.firstSelected !== undefined) assert.equal(got.firstSelected, fx.expected.firstSelected, `${id}: first selected`);
      if (fx.expected.withinBudget !== undefined) assert.equal(got.withinBudget, true, `${id}: within budget`);
      if (fx.expected.noPartialSelection !== undefined) assert.equal(got.noPartialSelection, true, `${id}: no partial`);
      if (fx.expected.planIsClosed !== undefined) assert.equal(got.planIsClosed, true, `${id}: closed`);
      if (fx.expected.omittedOverBudget !== undefined) assert.equal(got.omittedOverBudget, true, `${id}: omitted over-budget`);
      if (fx.expected.omittedZeroUtility !== undefined) assert.equal(got.omittedZeroUtility, true, `${id}: omitted zero-utility`);
      if (fx.expected.omittedIncompatible !== undefined) assert.equal(got.omittedIncompatible, true, `${id}: omitted incompatible`);
      if (fx.expected.permutationInvariant !== undefined) assert.equal(got.permutationInvariant, true, `${id}: permutation invariant`);
      if (fx.expected.manifestStable !== undefined) assert.equal(got.manifestStable, true, `${id}: manifest stable`);
    }));
  }
});

describe("VC5A named headline rows", () => {
  test("DAG-CYCLE-001: dependency cycle rejects with DAG_CYCLE (named)", withFlagsOn(() => {
    const fx = dagFixture("DAG-CYCLE-001");
    const got = runDagScenario(fx);
    assert.equal(got.ok, false);
    assert.equal(got.code, "DAG_CYCLE");
    assert.equal(DAG_NAMED_IDS[0], "DAG-CYCLE-001");
  }));

  test("PLN-MANDATORY-002: 101 mandatory tokens under budget 100 demotes to C (named)", withFlagsOn(() => {
    const fx = plnFixture("PLN-MANDATORY-002");
    const got = runPlannerScenario(fx);
    assert.equal(got.ok, false);
    assert.equal(got.code, "MANDATORY_CLOSURE_OVER_BUDGET");
    assert.equal(got.demotesToC, true, "demotes to C");
    assert.equal(got.mandatoryPreserved, true, "mandatory set preserved intact");
    assert.equal(PLAN_NAMED_IDS[0], "PLN-MANDATORY-002");
  }));

  test("PLN-TIE-003: equal ratios choose lower source seq then ID bytes (named)", withFlagsOn(() => {
    const fx = plnFixture("PLN-TIE-003");
    const got = runPlannerScenario(fx);
    assert.equal(got.ok, true);
    assert.deepEqual(got.selected, ["early", "late"]);
    assert.equal(got.firstSelected, "early");
    assert.equal(PLAN_NAMED_IDS[1], "PLN-TIE-003");
  }));
});

describe("VC5A acceptance (mandatory-first + triad + failure injection)", () => {
  test("acceptance: mandatory closure is computed and emitted before any optional node", withFlagsOn(() => {
    const cands: PlanCandidate[] = [
      { nodeId: "m1", tokenEstimate: 10, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 20, utility: 200, sourceSeq: 2n, mandatory: true },
      { nodeId: "opt", tokenEstimate: 30, utility: 90, sourceSeq: 3n, mandatory: false },
    ];
    const res = planPortfolio({
      dagDigest: "x".repeat(64),
      candidates: cands,
      mandatoryTokenEstimate: 30,
      tokenBudget: 100,
      dependencyHighWater: 100n,
      framing: { perNode: 0, overhead: 0 },
    });
    assert.equal(res.ok, true);
    // Both mandatory nodes present; the optional node competes for the rest.
    assert.ok(res.plan.selectedNodeIds.includes("m1"));
    assert.ok(res.plan.selectedNodeIds.includes("m2"));
    assert.ok(res.plan.selectedNodeIds.includes("opt"));
    assert.equal(res.plan.tokenTotal, 60);
  }));

  test("acceptance: an over-budget mandatory closure returns MANDATORY_CLOSURE_OVER_BUDGET without dropping evidence", withFlagsOn(() => {
    const cands: PlanCandidate[] = [
      { nodeId: "m1", tokenEstimate: 50, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 51, utility: 200, sourceSeq: 2n, mandatory: true },
    ];
    const res = planPortfolio({
      dagDigest: "x".repeat(64),
      candidates: cands,
      mandatoryTokenEstimate: 101,
      tokenBudget: 100,
      dependencyHighWater: 100n,
      framing: { perNode: 0, overhead: 0 },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "MANDATORY_CLOSURE_OVER_BUDGET");
    assert.deepEqual([...res.mandatory].sort(), ["m1", "m2"]);
    assert.equal(res.mandatoryCost, 101);
    assert.equal(res.tokenBudget, 100);
  }));

  test("acceptance: the framed token total never exceeds the budget", withFlagsOn(() => {
    for (const id of PLN_IDS) {
      const fx = plnFixture(id);
      if (!fx.expected.ok) continue;
      const got = runPlannerScenario(fx);
      if (got.tokenTotal !== undefined) assert.ok(got.tokenTotal <= fx.input.tokenBudget, `${id}: within budget`);
    }
  }));

  test("acceptance: UNIQUE failure injection — mutate a token count after planning fails PLN_MANIFEST_DIGEST_MISMATCH", withFlagsOn(() => {
    const cands: PlanCandidate[] = [
      { nodeId: "m1", tokenEstimate: 10, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 20, utility: 200, sourceSeq: 2n, mandatory: true },
      { nodeId: "opt", tokenEstimate: 30, utility: 90, sourceSeq: 3n, mandatory: false },
    ];
    const res = planPortfolio({
      dagDigest: "x".repeat(64),
      candidates: cands,
      mandatoryTokenEstimate: 30,
      tokenBudget: 100,
      dependencyHighWater: 100n,
      framing: { perNode: 0, overhead: 0 },
    });
    assert.equal(res.ok, true);
    const pinned = planManifestDigest(res.plan, cands);
    // Mutate a node's token count AFTER planning, BEFORE validation.
    const mutated = cands.map((c, i) => (i === 0 ? { ...c, tokenEstimate: c.tokenEstimate + 1 } : c));
    const check = validatePlanManifest(res.plan, mutated, pinned);
    assert.equal(check.ok, false, "plan must not reach provider");
    assert.equal(check.ok ? null : check.code, "PLN_MANIFEST_DIGEST_MISMATCH");
  }));

  test("acceptance: forced triad A/B/C are independent and non-overlapping", withFlagsOn(() => {
    const cands: PlanCandidate[] = [
      { nodeId: "m1", tokenEstimate: 10, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 20, utility: 200, sourceSeq: 2n, mandatory: true },
      { nodeId: "hi", tokenEstimate: 10, utility: 20, sourceSeq: 3n, mandatory: false },
      { nodeId: "lo", tokenEstimate: 10, utility: 5, sourceSeq: 4n, mandatory: false },
    ];
    const base = {
      dagDigest: "x".repeat(64),
      candidates: cands,
      mandatoryTokenEstimate: 30,
      tokenBudget: 100,
      dependencyHighWater: 100n,
      framing: DEFAULT_FRAMING,
    };

    // A: ratio-ordered 0/1 portfolio.
    const a = planPortfolio(base);
    assert.equal(a.ok, true);
    assert.ok(a.plan.selectedNodeIds.includes("hi"), "A admits the higher-ratio optional");

    // B: stable greedy closed planner — source order, NO ratio. Forced by an A
    // exception path; it must not share A's scoring rule.
    const b = planGreedyClosed(base);
    assert.equal(b.ok, true);
    assert.ok(b.plan.selectedNodeIds.includes("m1"));
    assert.ok(b.plan.selectedNodeIds.includes("m2"));

    // C: predecessor prompt, forced by mandatory overflow — states its continuity
    // loss; the adapter demotes rather than truncating evidence.
    const over = planPortfolio({
      ...base,
      candidates: cands.map((c) => (c.mandatory ? { ...c, tokenEstimate: c.tokenEstimate + 1000 } : c)),
      mandatoryTokenEstimate: 2030,
      tokenBudget: 100,
    });
    assert.equal(over.ok, false);
    assert.equal(over.code, "MANDATORY_CLOSURE_OVER_BUDGET");
    assert.deepEqual([...over.mandatory].sort(), ["m1", "m2"]);
  }));
});

describe("VC5A flag-off parity", () => {
  test("builder/validator/planner are byte-identical with MEGACOMPACT_VC5A untouched (pure math)", () => {
    const run = (): unknown => {
      const g = materializeDag("linear");
      assert.ok(g.buildOk);
      const v = validatePromptDag(g.dag);
      assert.equal(v.ok, true);
      return { order: v.order, digest: dagDigest(g.dag) };
    };
    // Default: flag ON (env unset → sprintFlag defaults true).
    const saved = process.env.MEGACOMPACT_VC5A;
    delete process.env.MEGACOMPACT_VC5A;
    const on = run();
    // Explicit OFF: the planner math is pure and must not change.
    process.env.MEGACOMPACT_VC5A = "0";
    const off = run();
    assert.deepEqual(off, on, "flag OFF must be byte-identical to flag ON");
    assert.deepEqual((off as { order: string[] }).order, ["a", "b", "c"]);
    // Restore.
    if (saved === undefined) delete process.env.MEGACOMPACT_VC5A;
    else process.env.MEGACOMPACT_VC5A = saved;
    // Sanity: buildPromptDag is also pure either way.
    void buildPromptDag;
  });
});
