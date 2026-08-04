/**
 * heal/vc6b-flag-parity.test.ts — flag-off byte-identical arithmetic.
 *
 * restore + verify are pure: identical results with MEGACOMPACT_VC6B
 * unset vs '0'. Only the reporter is flag-gated.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { RestoreResultV1 } from "./restore-types.js";
import { RESTORE_IDS, RESTORE_NAMED_IDS } from "./restore-types.js";
import { restorationFixture } from "./_restore-fixture.js";
import { runReal } from "./_vc6b-helpers.js";
import { verifyRestored } from "./verify.js";

const ALL_IDS = [...RESTORE_IDS, ...RESTORE_NAMED_IDS];

describe("VC6B acceptance: flag-off byte-identical arithmetic", () => {
  test("restore + verify are pure: identical with MEGACOMPACT_VC6B unset vs '0'", () => {
    const saved = process.env.MEGACOMPACT_VC6B;
    try {
      const runAll = (): Array<{
        result: RestoreResultV1;
        verification: ReturnType<typeof verifyRestored>;
      }> =>
        ALL_IDS.map((id) => {
          const { result, verification } = runReal(restorationFixture(id));
          return { result, verification };
        });

      delete process.env.MEGACOMPACT_VC6B;
      const on = runAll();
      process.env.MEGACOMPACT_VC6B = "0";
      const off = runAll();

      assert.deepEqual(off, on, "flag OFF must be byte-identical to flag ON");
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6B;
      else process.env.MEGACOMPACT_VC6B = saved;
    }
  });
});
