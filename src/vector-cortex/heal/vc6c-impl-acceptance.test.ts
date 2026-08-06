/**
 * heal/vc6c-impl-acceptance.test.ts — VC6C-IMPL production-self-healing acceptance.
 *
 * Drives the six registered VC6C-IMPL-001..006 fixtures through the REAL
 * production modules that this sprint wired into the compact path — the heal
 * policy layer (`detectGaps` / `isPlannable`) AND the production plan/rebuild
 * seam (`buildRepairPlan`, `rebuildRepairRange`) — and asserts each returns the
 * verdict its manifest row pins. No mocks/stubs: fixtures are decoded into
 * genuine `RepairState` / `RebuildInput` / production `RepairPlanV1` objects.
 *
 * This disaggregator is the body behind the aggregate shims
 * `vc6c-impl-acceptance.test.ts` (which re-exports it) and the published
 * `dist/vector-cortex/vc6c-impl-acceptance.test.js` the spec mandates:
 *
 *   npm run build
 *   node --test dist/vector-cortex/vc6c-impl-acceptance.test.js
 *
 * (The publish-acceptance mirror places this `-acceptance.test.js` under
 * dist/vector-cortex/heal/, where its `./...` and `../reconstruct/...` imports
 * resolve against the published subtree mirrors.)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { detectGaps, isPlannable } from "./controller.js";
import { decodeRebuild, decodeState, withVc6cFlagsOn } from "./_repair-fixture.js";
import {
  VC6C_IMPL_IDS,
  vc6cImplFixture,
} from "./_vc6c-impl-fixture.js";
import { buildRepairPlan } from "../reconstruct/repair-plan.js";
import { rebuildRepairRange } from "../reconstruct/rebuild.js";
import type { RepairFx } from "./_repair-fixture.js";

/** Run one fixture through the real modules and assert its pinned verdict. */
function runFixture(fx: RepairFx): void {
  const nowMs = BigInt(fx.input.nowMs);
  const avg = fx.input.states.map(decodeState);
  const plans = detectGaps(avg, nowMs);
  assert.equal(
    plans.length,
    fx.expected.plannedCount,
    `${fx.id}: plan count — ${fx.assertion}`,
  );
  assert.deepEqual(
    plans.map((p) => [Number(p.range.seqStart), Number(p.range.seqEnd)]),
    fx.expected.ranges,
    `${fx.id}: planned windows — ${fx.assertion}`,
  );

  if (fx.input.mode === "detect" && plans.length > 0) {
    // Production plan seam must mirror the heal windows 1:1 (VC6C-IMPL-004).
    const bySubsystem = new Map(avg.map((s) => [s.subsystem, s]));
    for (const p of plans) {
      const state = bySubsystem.get(p.subsystem);
      assert.ok(state, `${fx.id}: heal plan names a gapped subsystem`);
      const prod = buildRepairPlan({
        subsystem: state!.subsystem,
        postCount: Number(state!.derivedHighWater),
        authorityHighWater: Number(state!.authorityHighWater),
        generation: state!.generation,
        failedAttempts: state!.failedAttempts ?? 0,
        mode: state!.mode,
      });
      assert.deepEqual(
        prod.range,
        [Number(p.range.seqStart), Number(p.range.seqEnd)],
        `${fx.id}: production plan range must equal the heal window`,
      );
      assert.equal(
        prod.generation,
        p.generation,
        `${fx.id}: production plan must target the same new generation`,
      );
      assert.equal(prod.backoffMs, p.backoffMs, `${fx.id}: production plan backoff`);
    }
  }

  if (fx.input.mode === "rebuild") {
    const spec = fx.input.rebuild;
    assert.ok(spec, `${fx.id}: rebuild rows must carry input.rebuild`);
    const plan = buildRepairPlan({
      subsystem: spec!.subsystem,
      postCount: 0,
      authorityHighWater: 1,
      generation: spec!.currentGeneration,
      failedAttempts: 0,
      mode: spec!.triadMode,
    });
    const rebuilt = rebuildRepairRange(
      plan,
      decodeRebuild(spec!),
      spec!.currentGeneration,
      spec!.triadMode,
    );
    assert.equal(
      rebuilt.result.ok,
      fx.expected.ok,
      `${fx.id}: rebuild verdict — ${fx.assertion}`,
    );
    if (!rebuilt.result.ok) {
      assert.equal(rebuilt.result.code, fx.expected.code, `${fx.id}: failure code`);
    }
    assert.equal(
      rebuilt.pointer.switched,
      fx.expected.switched,
      `${fx.id}: pointer switched — ${fx.assertion}`,
    );
    assert.equal(
      rebuilt.pointer.generation,
      fx.expected.generation,
      `${fx.id}: live generation after attempt`,
    );
    if (fx.expected.idempotent === true) {
      const again = rebuildRepairRange(
        plan,
        decodeRebuild(spec!),
        rebuilt.pointer.generation,
        spec!.triadMode,
      );
      assert.equal(
        again.pointer.switched,
        false,
        `${fx.id}: a replay must not advance the pointer again`,
      );
    }
  }
}

describe("VC6C-IMPL self-healing conformance corpus", () => {
  test(
    "every registered VC6C-IMPL-001..006 row is present in the manifest",
    withVc6cFlagsOn(() => {
      for (const id of VC6C_IMPL_IDS) {
        const fx = vc6cImplFixture(id);
        assert.equal(fx.id, id);
        assert.equal(fx.kind, "healing-controller");
        assert.ok(fx.assertion.length > 0, `${id} must state its assertion`);
      }
      assert.equal(VC6C_IMPL_IDS.length, 6, "six VC6C-IMPL fixtures");
    }),
  );

  for (const id of VC6C_IMPL_IDS) {
    test(
      `${id} returns its pinned verdict against the real production modules`,
      withVc6cFlagsOn(() => {
        runFixture(vc6cImplFixture(id));
      }),
    );
  }
});

describe("VC6C-IMPL headline assertions", () => {
  test(
    "VC6C-IMPL-006: no rebuild without a real gap (level-with-authority emits nothing)",
    withVc6cFlagsOn(() => {
      const fx = vc6cImplFixture("VC6C-IMPL-006");
      const state = decodeState(fx.input.states[0]!);
      assert.equal(
        isPlannable(state, BigInt(fx.input.nowMs)),
        false,
        "level-with-authority is not plannable",
      );
      assert.deepEqual(
        detectGaps([state], BigInt(fx.input.nowMs)),
        [],
        "no plan without a real gap",
      );
    }),
  );

  test(
    "VC6C-IMPL-002: a second rebuild inside the 5-minute window is suppressed (boundary exclusive)",
    withVc6cFlagsOn(() => {
      const fx = vc6cImplFixture("VC6C-IMPL-002");
      const state = decodeState(fx.input.states[0]!);
      assert.equal(
        isPlannable(state, BigInt(fx.input.nowMs)),
        false,
        "inside the rate-limit window the rebuild is suppressed",
      );
      assert.deepEqual(
        detectGaps([state], BigInt(fx.input.nowMs)),
        [],
        "the 5-minute window must suppress the rebuild",
      );
    }),
  );
});

describe("VC6C-IMPL flag parity", () => {
  test("flag OFF changes nothing in the plan arithmetic (reporters are the only gate)", () => {
    const fx = vc6cImplFixture("VC6C-IMPL-001");
    const states = fx.input.states.map(decodeState);
    const now = BigInt(fx.input.nowMs);

    const saved = process.env.MEGACOMPACT_VC6C;
    try {
      process.env.MEGACOMPACT_VC6C = "1";
      const on = detectGaps(states, now);
      process.env.MEGACOMPACT_VC6C = "0";
      const off = detectGaps(states, now);
      assert.deepEqual(
        off.map((p) => [p.subsystem, p.range.seqStart, p.range.seqEnd, p.backoffMs]),
        on.map((p) => [p.subsystem, p.range.seqStart, p.range.seqEnd, p.backoffMs]),
        "flag OFF must not change the gap arithmetic",
      );
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6C;
      else process.env.MEGACOMPACT_VC6C = saved;
    }
  });
});
