/**
 * heal/vc6c-acceptance.test.ts — VC6C conformance corpus acceptance.
 *
 * Drives every registered healing-controller fixture (HEAL-031..045 + the three
 * named headline rows) through the REAL production modules — `detectGaps`,
 * `computeBackoff`, `rebuildGeneration`, `switchPointer` — and asserts each
 * returns the verdict its manifest row pins. No mocks, no stubs, no parallel
 * "test shape": the fixtures are decoded into genuine `RepairState` /
 * `RebuildInput` objects by `_repair-fixture.ts`.
 *
 * RANGES ARE CHECKED, NOT JUST COUNTS. A controller that plans the right NUMBER
 * of rebuilds but the wrong WINDOW (an off-by-one at the derived frontier, or a
 * jump to the spool tail during an outage) is exactly the bug this sprint exists
 * to prevent, so every detect row pins each plan's [seqStart, seqEnd].
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBackoff,
  detectGaps,
} from "./controller.js";
import { applyTriad, switchPointer } from "./rebuild.js";
import {
  REPAIR_BACKOFF_CAP_MS,
  REPAIR_BACKOFF_JITTER,
  REPAIR_IDS,
  REPAIR_NAMED_IDS,
} from "./repair-types.js";
import {
  decodeRebuild,
  decodeState,
  repairFixture,
  withVc6cFlagsOn,
  type RepairFx,
} from "./_repair-fixture.js";

/** Every registered VC6C row: the numbered range plus the named headlines. */
const ALL_IDS: readonly string[] = [...REPAIR_IDS, ...REPAIR_NAMED_IDS];

/** Run one fixture through the real modules and assert its pinned verdict. */
function runFixture(fx: RepairFx): void {
  const nowMs = BigInt(fx.input.nowMs);

  if (fx.input.mode === "detect") {
    const plans = detectGaps(fx.input.states.map(decodeState), nowMs);
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
    // Every plan targets a NEW generation, never the live one.
    for (const p of plans) {
      assert.ok(p.generation >= 1, `${fx.id}: generation must advance`);
      assert.equal(p.scheduledAt, nowMs + BigInt(p.backoffMs), `${fx.id}: schedule`);
    }
    return;
  }

  if (fx.input.mode === "rebuild") {
    const spec = fx.input.rebuild;
    assert.ok(spec, `${fx.id}: rebuild rows must carry input.rebuild`);
    const result = applyTriad(spec!.triadMode, decodeRebuild(spec!));
    const pointer = switchPointer(spec!.currentGeneration, spec!.generation, result.ok);

    assert.equal(result.ok, fx.expected.ok, `${fx.id}: verdict — ${fx.assertion}`);
    if (!result.ok) {
      assert.equal(result.code, fx.expected.code, `${fx.id}: failure code`);
      if (fx.expected.semanticLossStated === true) {
        assert.equal(
          result.semanticLossStated,
          true,
          `${fx.id}: mode C MUST disclose its loss of old semantic context`,
        );
      }
    }
    assert.equal(pointer.switched, fx.expected.switched, `${fx.id}: pointer switched`);
    assert.equal(pointer.generation, fx.expected.generation, `${fx.id}: live generation`);

    if (fx.expected.idempotent === true) {
      // Re-applying the same plan must not advance again (exactly once).
      const again = switchPointer(pointer.generation, spec!.generation, result.ok);
      assert.equal(again.switched, false, `${fx.id}: switch must be exactly once`);
      assert.equal(again.generation, pointer.generation, `${fx.id}: generation stable`);
    }
    return;
  }

  // Backoff rows: determinism, growth, and the cap.
  const spec = fx.input.backoff;
  assert.ok(spec, `${fx.id}: backoff rows must carry input.backoff`);
  const delays = spec!.attempts.map((a) => computeBackoff(spec!.subsystem, a));

  for (const [i, a] of spec!.attempts.entries()) {
    assert.equal(
      delays[i],
      computeBackoff(spec!.subsystem, a),
      `${fx.id}: attempt ${a} must be reproducible (no Math.random)`,
    );
    assert.ok(Number.isInteger(delays[i]!), `${fx.id}: attempt ${a} must be integer ms`);
  }

  if (fx.expected.monotonic === true) {
    for (let i = 1; i < delays.length; i++) {
      assert.ok(
        delays[i]! > delays[i - 1]!,
        `${fx.id}: backoff must grow (${delays[i - 1]} -> ${delays[i]})`,
      );
    }
  }

  if (fx.expected.capped === true) {
    const ceiling = REPAIR_BACKOFF_CAP_MS * (1 + REPAIR_BACKOFF_JITTER);
    for (const [i, d] of delays.entries()) {
      assert.ok(d <= ceiling, `${fx.id}: attempt ${spec!.attempts[i]} (${d}) exceeds cap`);
      assert.ok(Number.isFinite(d), `${fx.id}: backoff must never be Infinity/NaN`);
    }
  }
}

describe("VC6C healing-controller conformance corpus", () => {
  test(
    "every registered HEAL-031..045 + named row is present in the manifest",
    withVc6cFlagsOn(() => {
      for (const id of ALL_IDS) {
        const fx = repairFixture(id);
        assert.equal(fx.id, id);
        assert.equal(fx.kind, "healing-controller");
        assert.ok(fx.assertion.length > 0, `${id} must state its assertion`);
      }
      assert.equal(ALL_IDS.length, 18, "15 numbered + 3 named rows");
    }),
  );

  for (const id of ALL_IDS) {
    test(
      `${id} returns its pinned verdict against the real modules`,
      withVc6cFlagsOn(() => {
        runFixture(repairFixture(id));
      }),
    );
  }
});

describe("VC6C named headline assertions", () => {
  test(
    "HEAL-GAP-001: topology high-water 8 vs authority 10 plans range 9..10",
    withVc6cFlagsOn(() => {
      const fx = repairFixture("HEAL-GAP-001");
      const plans = detectGaps(fx.input.states.map(decodeState), BigInt(fx.input.nowMs));
      assert.equal(plans.length, 1);
      assert.equal(plans[0]!.range.seqStart, 9n);
      assert.equal(plans[0]!.range.seqEnd, 10n);
    }),
  );

  test(
    "HEAL-RATE-002: a second rebuild inside 5 minutes is suppressed",
    withVc6cFlagsOn(() => {
      const fx = repairFixture("HEAL-RATE-002");
      const plans = detectGaps(fx.input.states.map(decodeState), BigInt(fx.input.nowMs));
      assert.deepEqual(plans, [], "the 5-minute window must suppress the rebuild");
    }),
  );

  test(
    "HEAL-SWITCH-003: a verified root changes the pointer exactly once",
    withVc6cFlagsOn(() => {
      const fx = repairFixture("HEAL-SWITCH-003");
      const spec = fx.input.rebuild!;
      const result = applyTriad(spec.triadMode, decodeRebuild(spec));
      assert.equal(result.ok, true);
      const first = switchPointer(spec.currentGeneration, spec.generation, result.ok);
      assert.deepEqual(first, { switched: true, generation: spec.generation });
      const second = switchPointer(first.generation, spec.generation, result.ok);
      assert.equal(second.switched, false, "exactly once");
    }),
  );
});

describe("VC6C flag parity", () => {
  test("the arithmetic is identical with MEGACOMPACT_VC6C off (flag gates reporting only)", () => {
    const fx = repairFixture("HEAL-GAP-001");
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

      // The safety property also survives the flag being off.
      assert.equal(switchPointer(1, 2, false).switched, false);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6C;
      else process.env.MEGACOMPACT_VC6C = saved;
    }
  });
});
