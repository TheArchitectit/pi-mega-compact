/**
 * prompt-dag/_acceptance-planner.ts — declarative candidate-set materialization
 * + scenario driver for VC5A planner acceptance rows.
 *
 * Turns named candidate-set scenarios into real `PlanCandidate[]` values and
 * drives them through the REAL portfolio planner (planPortfolio). The
 * `mandatoryTokenEstimate` is the VC4C content-only figure = sum of mandatory
 * content tokens (zero-framing fixtures pin this exactly).
 */
import assert from "node:assert/strict";
import {
  planPortfolio,
  planManifestDigest,
  validatePlanManifest,
} from "../planner/portfolio.js";
import { DEFAULT_FRAMING } from "../planner/types.js";
import type { FramingProfile, PlanCandidate } from "../planner/types.js";
import type { PlnFixture } from "./_acceptance-fixture.js";
import { shuffle } from "./_acceptance-shuffle.js";

export function materializeCandidates(name: string): PlanCandidate[] {
  const sets: Record<string, PlanCandidate[]> = {
    // m1=10, m2=20 mandatory → 30 content tokens (zero-framing fixtures pin this).
    "mandatory-only": [
      { nodeId: "m1", tokenEstimate: 10, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 20, utility: 200, sourceSeq: 2n, mandatory: true },
    ],
    // Two mandatory nodes totalling 101 content tokens → over budget at 100.
    "mandatory-101": [
      { nodeId: "m1", tokenEstimate: 50, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 51, utility: 200, sourceSeq: 2n, mandatory: true },
    ],
    // Optional candidates: hi=10t/20u (ratio 2.0), mid=10t/10u (ratio 1.0), lo=10t/5u.
    ratio: [
      { nodeId: "hi", tokenEstimate: 10, utility: 20, sourceSeq: 1n, mandatory: false },
      { nodeId: "mid", tokenEstimate: 10, utility: 10, sourceSeq: 2n, mandatory: false },
      { nodeId: "lo", tokenEstimate: 10, utility: 5, sourceSeq: 3n, mandatory: false },
    ],
    // Equal ratios (1.0) → source seq tie-break (early=seq1 wins).
    "tie-seq": [
      { nodeId: "early", tokenEstimate: 10, utility: 10, sourceSeq: 1n, mandatory: false },
      { nodeId: "late", tokenEstimate: 10, utility: 10, sourceSeq: 2n, mandatory: false },
    ],
    // Equal ratios AND equal source seq → lower ID bytes wins.
    "tie-id": [
      { nodeId: "bbb", tokenEstimate: 10, utility: 10, sourceSeq: 1n, mandatory: false },
      { nodeId: "aaa", tokenEstimate: 10, utility: 10, sourceSeq: 1n, mandatory: false },
    ],
    // One indivisible optional node of 10t/10u: 0/1 means it is taken whole.
    indivisible: [
      { nodeId: "one", tokenEstimate: 10, utility: 10, sourceSeq: 1n, mandatory: false },
    ],
    // A zero-utility optional node must be omitted.
    "zero-utility": [
      { nodeId: "zero", tokenEstimate: 5, utility: 0, sourceSeq: 1n, mandatory: false },
    ],
    // An optional node incompatible with a mandatory node is omitted (the planner
    // enforces `incompatiblePairs`; here `bad` is mutually exclusive with `m1`).
    incompatible: [
      { nodeId: "m1", tokenEstimate: 10, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "bad", tokenEstimate: 5, utility: 50, sourceSeq: 2n, mandatory: false },
    ],
    // Mixed: 2 mandatory + optional candidates exercising closure + selection.
    mixed: [
      { nodeId: "m1", tokenEstimate: 10, utility: 100, sourceSeq: 1n, mandatory: true },
      { nodeId: "m2", tokenEstimate: 20, utility: 200, sourceSeq: 2n, mandatory: true },
      { nodeId: "opt", tokenEstimate: 30, utility: 90, sourceSeq: 3n, mandatory: false },
    ],
  };
  const set = sets[name];
  assert.ok(set, `candidate-set materializer missing for "${name}"`);
  return set;
}

function framing(zero?: boolean): FramingProfile {
  return zero ? { perNode: 0, overhead: 0 } : DEFAULT_FRAMING;
}

export interface PlnResult {
  ok: boolean;
  code?: string;
  selected?: string[];
  tokenTotal?: number;
  firstSelected?: string;
  mandatoryPreserved?: boolean;
  demotesToC?: boolean;
  omittedOverBudget?: boolean;
  omittedZeroUtility?: boolean;
  omittedIncompatible?: boolean;
  noPartialSelection?: boolean;
  withinBudget?: boolean;
  planIsClosed?: boolean;
  permutationInvariant?: boolean;
  manifestStable?: boolean;
}

/**
 * Drive a planner fixture scenario through the REAL portfolio planner. The
 * `mandatoryTokenEstimate` is the VC4C CONTENT-ONLY figure = sum of mandatory
 * content tokens (zero-framing fixtures make that the exact candidate sum).
 */
export function runPlannerScenario(fx: PlnFixture): PlnResult {
  const { candidates: setName, tokenBudget, zeroFraming, permute, mutateTokensAfterPlan } = fx.input;
  const cands = materializeCandidates(setName);

  // VC4C content-only mandatory estimate = sum of mandatory content tokens.
  const mandatoryTokenEstimate = cands
    .filter((c) => c.mandatory)
    .reduce((s, c) => s + c.tokenEstimate, 0);

  const dagDigest = "deadbeef".repeat(8);
  // The `incompatible` set wires an explicit mutual-exclusion pair (bad ⊥ m1) so
  // the planner's incompatibility gate is exercised end-to-end.
  const incompatiblePairs =
    setName === "incompatible" ? ([["bad", "m1"]] as [string, string][]) : undefined;
  const input = {
    dagDigest,
    candidates: permute ? shuffle([...cands]) : cands,
    mandatoryTokenEstimate,
    tokenBudget,
    dependencyHighWater: 100n,
    framing: framing(zeroFraming),
    ...(incompatiblePairs ? { incompatiblePairs } : {}),
  };

  const res = planPortfolio(input);

  if (fx.expected.permutationInvariant) {
    const a = planPortfolio(input);
    const b = planPortfolio({ ...input, candidates: shuffle([...cands]) });
    const ids = (ok: typeof a): string[] => (ok.ok ? [...ok.plan.selectedNodeIds] : []);
    return { ok: true, permutationInvariant: JSON.stringify(ids(a)) === JSON.stringify(ids(b)) };
  }

  if (!res.ok) {
    // Over-budget failure: mandatory set preserved intact, demotes to C.
    const mandatoryIds = cands.filter((c) => c.mandatory).map((c) => c.nodeId).sort();
    const preserved = res.mandatory.slice().sort().join(",") === mandatoryIds.join(",");
    return {
      ok: false,
      code: res.code,
      mandatoryPreserved: preserved,
      demotesToC: res.code === "MANDATORY_CLOSURE_OVER_BUDGET",
    };
  }

  // ── Accepted-plan assertions ──
  const plan = res.plan;
  const selected = [...plan.selectedNodeIds];
  const out: PlnResult = { ok: true, selected, tokenTotal: plan.tokenTotal };
  if (fx.expected.firstSelected !== undefined) out.firstSelected = selected[0];
  if (fx.expected.withinBudget) out.withinBudget = plan.tokenTotal <= tokenBudget;
  if (fx.expected.noPartialSelection) {
    out.noPartialSelection = cands.every(
      (c) => !c.mandatory || selected.includes(c.nodeId),
    );
  }
  if (fx.expected.planIsClosed) {
    const mandatoryIds = cands.filter((c) => c.mandatory).map((c) => c.nodeId).sort();
    out.planIsClosed = mandatoryIds.every((id) => selected.includes(id));
  }
  if (fx.expected.omittedOverBudget) {
    const omit = plan.omissions.some((o) => o.reason === "over-budget");
    out.omittedOverBudget = omit;
  }
  if (fx.expected.omittedZeroUtility) {
    out.omittedZeroUtility = plan.omissions.some((o) => o.reason === "zero-utility");
  }
  if (fx.expected.omittedIncompatible) {
    out.omittedIncompatible = plan.omissions.some((o) => o.reason === "incompatible");
  }

  // Manifest identity: a post-plan token mutation must fail revalidation.
  if (mutateTokensAfterPlan) {
    const pinned = planManifestDigest(plan, cands);
    const mutated = cands.map((c, i) => (i === 0 ? { ...c, tokenEstimate: c.tokenEstimate + 1 } : c));
    const check = validatePlanManifest(plan, mutated, pinned);
    out.ok = check.ok; // false → plan rejected, never reaches provider
    out.code = check.ok ? undefined : check.code;
    return out;
  }
  if (fx.expected.manifestStable) {
    const pinned = planManifestDigest(plan, cands);
    const check = validatePlanManifest(plan, cands, pinned);
    out.manifestStable = check.ok;
  }
  return out;
}
