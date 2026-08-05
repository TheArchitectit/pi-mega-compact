/**
 * cache/flag-parity-vc7b.test.ts — VC7B flag-off byte-identity.
 *
 * The sprint contract: `MEGACOMPACT_VC7B=0` must be byte-identical to the
 * predecessor (VC7A) for every observable arithmetic result. The economics,
 * compiler, and experiments code is PURE and must NEVER read the flag — only the
 * reporter seam in `../cache/economics-emit.ts` is gated. So this file asserts
 * both halves, mirroring `flag-parity.test.ts`:
 *
 *   1. ARITHMETIC IS FLAG-INDEPENDENT. Every net-savings figure, every compiled
 *      boundary identity, every assigned arm is identical with the flag on and
 *      off. If the flag leaked into `economics.ts` / `compiler.ts` /
 *      `experiments.ts`, these rows would diverge.
 *   2. THE SEAM IS FLAG-GATED. With the flag off, neither VC7B event is emitted,
 *      even though the same assignment / economics computation occurred.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeEconomics, type CacheUsageV1, type ProviderEconomicsV1 } from "../provider/economics.js";
import { compileCrystalBoundaries, type CrystalBoundaryV1 } from "./compiler.js";
import { assignExperiment } from "../provider/experiments.js";
import { reportCacheExperimentAssigned, reportCacheEconomicsEstimated } from "./economics-emit.js";
import { withVc7bFlag } from "./_economics-fixture.js";
import type { DagSpan } from "./types.js";
import { computeCoveredDigest } from "./crystal.js";

const ECON: ProviderEconomicsV1 = {
  schema: "provider-economics-v1",
  profileId: "anthropic-claude-opus",
  profileVersion: "v1",
  basePrice: 1000,
  readPrice: 100,
  writePrice: 1250,
  ttlMs: 300_000,
  minPrefix: 1024,
  exclusionFixtureId: null,
};
const USAGE: CacheUsageV1 = { cachedTokens: 1000, writeCount: 1, hitCount: 10 };

const span = (sessionId: string, start: number, end: number): DagSpan => ({
  sessionId,
  startSeq: 0n,
  endSeq: 1n,
  startByte: start,
  endByte: end,
  digest: `sha256:${sessionId}-${start}-${end}` as DagSpan["digest"],
});

/** Observable VC7B arithmetic — the golden bytes both flag states compare. */
function summary(): string {
  const parts: string[] = [];
  const econ = computeEconomics(ECON, USAGE, "measured");
  parts.push(`net=${econ.ok ? econ.result.netSavings : "FAIL"}`);
  parts.push(`token=${econ.ok ? econ.result.tokenSavings : "FAIL"}`);

  const ranges = [span("s1", 0, 8192), span("s1", 8192, 16384)];
  const compiled = compileCrystalBoundaries(ranges);
  parts.push(`bnd=${compiled.ok ? compiled.boundaries.length : "FAIL"}`);
  parts.push(
    `bndIdentity=${
      compiled.ok
        ? compiled.boundaries.map((b: CrystalBoundaryV1) => b.cacheable).join(",")
        : "FAIL"
    }`,
  );

  const a = assignExperiment({ experimentId: "exp-x", sessionId: "session-42", assignedAt: 123 });
  parts.push(`arm=${a.ok ? a.assignment.arm : "FAIL"}`);
  parts.push(`bucket=${a.ok ? a.assignment.bucket : "FAIL"}`);
  return parts.join("\n");
}

test("VC7B flag parity: economics/compiler/experiment arithmetic is byte-identical ON vs OFF", () => {
  let on = "";
  let off = "";
  withVc7bFlag("1", () => {
    on = summary();
  })();
  withVc7bFlag("0", () => {
    off = summary();
  })();
  assert.ok(on.length > 0);
  assert.equal(off, on, "flag-off must not change a single savings figure, boundary, or arm");
});

test("VC7B flag parity: flag-ON emits both economics events", () => {
  const seen: string[] = [];
  withVc7bFlag("1", () => {
    reportCacheExperimentAssigned((n) => seen.push(n), {
      experimentId: "exp",
      arm: "A",
      bucket: 1,
      source: "randomized",
    });
    reportCacheEconomicsEstimated((n) => seen.push(n), {
      profileId: "p",
      netSavings: 5,
      tokenSavings: 10,
      evidence: "estimate",
    });
  })();
  assert.deepEqual(seen, [
    "vector_cortex_cache_experiment_assigned",
    "vector_cortex_cache_economics_estimated",
  ]);
});

test("VC7B flag parity: flag-OFF emits nothing even though the arithmetic ran", () => {
  const seen: string[] = [];
  withVc7bFlag("0", () => {
    // arithmetic still runs and still produces a result with the flag off
    const econ = computeEconomics(ECON, USAGE, "measured");
    assert.ok(econ.ok);
    const a = assignExperiment({ experimentId: "exp", sessionId: "s", assignedAt: 1 });
    assert.ok(a.ok);
    reportCacheExperimentAssigned((n) => seen.push(n), {
      experimentId: "exp",
      arm: "A",
      bucket: 1,
      source: "randomized",
    });
    reportCacheEconomicsEstimated((n) => seen.push(n), {
      profileId: "p",
      netSavings: 5,
      tokenSavings: 10,
      evidence: "estimate",
    });
  })();
  assert.deepEqual(seen, [], "no VC7B event may be emitted with the flag off");
});

test("VC7B: a throwing emitter is non-fatal and never breaks the agent loop", () => {
  withVc7bFlag("1", () => {
    assert.doesNotThrow(() => {
      reportCacheEconomicsEstimated(
        () => {
          throw new Error("reporter down");
        },
        { profileId: "p", netSavings: 1, tokenSavings: 2, evidence: "estimate" },
      );
    });
  })();
});

test("VC7B: an absent emitter is a no-op in both flag states", () => {
  for (const v of ["1", "0"]) {
    withVc7bFlag(v, () => {
      assert.doesNotThrow(() => {
        reportCacheExperimentAssigned(undefined, {
          experimentId: "exp",
          arm: "B",
          bucket: 2,
          source: "forced",
        });
        reportCacheEconomicsEstimated(undefined, {
          profileId: "p",
          netSavings: 1,
          tokenSavings: 2,
          evidence: "estimate",
        });
      });
    })();
  }
});

void computeCoveredDigest;
