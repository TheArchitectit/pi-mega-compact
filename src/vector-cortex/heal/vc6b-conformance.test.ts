/**
 * heal/vc6b-conformance.test.ts — manifest registration for VC6B restoration IDs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RESTORE_IDS, RESTORE_NAMED_IDS } from "./restore-types.js";
import { readManifest } from "./_acceptance-fixture.js";

const ALL_IDS = [...RESTORE_IDS, ...RESTORE_NAMED_IDS];

describe("VC6B conformance registration", () => {
  test("every RESTORE id is registered in the manifest under algorithm 'restoration'", () => {
    const m = readManifest();
    for (const id of ALL_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `manifest row present for ${id}`);
      assert.equal(row!.path.startsWith("restoration/"), true, `${id} under restoration/`);
      assert.equal(row!.algorithm, "restoration", `${id} algorithm=restoration`);
    }
  });

  test("the VC6B id range is HEAL-016..030 plus three named rows", () => {
    assert.equal(RESTORE_IDS.length, 15);
    assert.equal(RESTORE_IDS[0], "HEAL-016");
    assert.equal(RESTORE_IDS[14], "HEAL-030");
    assert.equal(RESTORE_NAMED_IDS.length, 3);
  });
});
