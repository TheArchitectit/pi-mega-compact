/**
 * heal/vc6b-fixture-acceptance.test.ts — drive every restoration fixture
 * (HEAL-016..030 + named) through the real restore + verify pipeline.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RESTORE_IDS, RESTORE_NAMED_IDS } from "./restore-types.js";
import { restorationFixture, withVc6bFlagsOn } from "./_restore-fixture.js";
import { runReal } from "./_vc6b-helpers.js";

const ALL_IDS = [...RESTORE_IDS, ...RESTORE_NAMED_IDS];

describe("VC6B restoration fixtures (HEAL-016..030 + named)", () => {
  for (const id of ALL_IDS) {
    test(
      `${id}: ${restorationFixture(id).assertion}`,
      withVc6bFlagsOn(() => {
        const fx = restorationFixture(id);
        const { result, verification } = runReal(fx);

        assert.equal(result.mode, fx.expected.mode, `${id}: mode`);
        assert.equal(result.restored.length, fx.expected.restoredCount, `${id}: restoredCount`);
        assert.equal(result.missing.length, fx.expected.missingCount, `${id}: missingCount`);

        if (fx.expected.ok) {
          assert.deepEqual(result.codes, [], `${id}: no failure codes`);
          assert.equal(verification.ok, true, `${id}: restoration verifies`);
          assert.equal(result.semanticLossStated, false, `${id}: no loss claimed`);
        } else {
          assert.ok(
            result.codes.includes(
              fx.expected.code as (typeof result.codes)[number],
            ),
            `${id}: pinned code ${fx.expected.code} present (got ${result.codes.join(",")})`,
          );
          if (result.mode === "C") {
            assert.equal(result.semanticLossStated, true, `${id}: mode C states loss`);
          }
        }
      }),
    );
  }
});
