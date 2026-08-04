/** VC2C unit tests — qualification fallback (fallback.ts).
 *
 *  Verifies the B/C triad selection: a qualification demotion (threshold/digest
 *  failure) selects independently-initialized trigram B at width 512 with no
 *  limitation; an injected B initializer error or a forced C selects lexical C
 *  at width 256 with the documented semantic-context limitation. Also verifies
 *  either path returns an explicit vector (never silent).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectQualificationFallback } from "./fallback.js";
import { ENC_QUALIFICATION_FAIL } from "./types.js";
import { ENCODER_TRIGRAM_WIDTH, embedTrigram512 } from "./trigram.js";
import { ENCODER_LEXICAL_WIDTH, ENCODER_LEXICAL_LIMITATION } from "./lexical.js";

const TOKENS = [1, 2, 3, 5, 8, 13];

describe("fallback.selectQualificationFallback — mode B (trigram)", () => {
  test("a qualification THRESHOLD failure selects trigram B at width 512, no limitation", () => {
    const v = selectQualificationFallback(ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED, TOKENS);
    assert.equal(v.ok, true);
    assert.equal(v.mode, "B");
    assert.equal(v.width, ENCODER_TRIGRAM_WIDTH);
    assert.equal(v.vector.length, ENCODER_TRIGRAM_WIDTH);
    assert.equal(v.limitation, null);
    assert.equal(v.code, ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED);
  });

  test("a qualification DIGEST_MISMATCH also selects trigram B", () => {
    const v = selectQualificationFallback(ENC_QUALIFICATION_FAIL.DIGEST_MISMATCH, TOKENS);
    assert.equal(v.ok, true);
    assert.equal(v.mode, "B");
    assert.equal(v.width, ENCODER_TRIGRAM_WIDTH);
  });

  test("B is the prepared, independently initialized trigram", () => {
    const v = selectQualificationFallback(ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED, TOKENS);
    const expected = embedTrigram512(TOKENS.join("-"));
    assert.equal(v.mode, "B");
    assert.deepEqual([...v.vector], [...expected], "B vector matches the standalone trigram");
  });
});

describe("fallback.selectQualificationFallback — mode C (lexical)", () => {
  test("an injected B initializer error forces lexical C at width 256 with limitation", () => {
    const v = selectQualificationFallback(ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED, TOKENS, { injectBError: true });
    assert.equal(v.ok, true);
    assert.equal(v.mode, "C");
    assert.equal(v.width, ENCODER_LEXICAL_WIDTH);
    assert.equal(v.vector.length, ENCODER_LEXICAL_WIDTH);
    assert.equal(v.limitation, ENCODER_LEXICAL_LIMITATION);
    assert.equal(v.code, "ENC_B_INJECTED_ERROR");
  });

  test("forceC selects lexical C directly even without an injected B error", () => {
    const v = selectQualificationFallback("ENC_ROLLBACK_ACTIVE", TOKENS, { forceC: true });
    assert.equal(v.ok, true);
    assert.equal(v.mode, "C");
    assert.equal(v.width, ENCODER_LEXICAL_WIDTH);
    assert.equal(v.limitation, ENCODER_LEXICAL_LIMITATION);
    assert.equal(v.code, "ENC_ROLLBACK_ACTIVE");
  });
});

describe("fallback.selectQualificationFallback — triad shape", () => {
  test("B and C use disjoint widths (512 vs 256)", () => {
    assert.notEqual(ENCODER_TRIGRAM_WIDTH, ENCODER_LEXICAL_WIDTH);
  });

  test("every path returns an explicit non-empty vector (never silent)", () => {
    const b = selectQualificationFallback(ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED, TOKENS);
    const c = selectQualificationFallback(ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED, TOKENS, { injectBError: true });
    assert.equal(b.vector.length > 0, true);
    assert.equal(c.vector.length > 0, true);
  });
});
