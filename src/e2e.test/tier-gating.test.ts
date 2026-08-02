/**
 * tier-gating.test.ts — Feature flag toggling tests (L0/L1/L2 enable/disable).
 * Split from e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vectorList } from "../vectorStore.js";
import { store } from "./_helpers.js";

test("12a. L0_ENABLED=false — L0 does not collapse exact dups", () => {
  const s = store({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: false });
  const SESS = "sess_l0_off";

  const r1 = s.add({
    sessionId: SESS,
    summary: "first checkpoint about the parser",
    regionText: "the parser tokenizes the input into a stream of tokens for the compiler version one",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "second checkpoint about the parser",
    regionText: "the parser tokenizes the input into a stream of tokens for the compiler version two",
    timestamp: 2,
  });

  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, false, "L0 disabled → near-dup not collapsed");
  assert.equal(vectorList(s, SESS).length, 2, "both checkpoints stored when L0 is off");
});

test("12b. MARK_ONLY_L1=true — L1 records but does not collapse", () => {
  const s = store({ L1_ENABLED: true, MARK_ONLY_L1: true, L2_ENABLED: false });
  const SESS = "sess_mark_only_l1";

  const r1 = s.add({
    sessionId: SESS,
    summary: "user worked on the parser optimization",
    regionText: "the parser optimized the hot loop with aggressive inlining",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "user worked on the parser optimization",
    regionText: "the parser optimized the hot loop with aggressive inlinings",
    timestamp: 2,
  });

  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, false, "MARK_ONLY_L1 → not collapsed");
  assert.equal(vectorList(s, SESS).length, 2, "both checkpoints stored (mark only)");

  const all = vectorList(s, SESS);
  assert.ok(all.every((c) => c.dedupStatus === "active"), "both rows active under MARK_ONLY");
});

test("12c. L2_ENABLED=false — L2 skipped but L0/L1 still work", () => {
  const s = store({ L2_ENABLED: false });
  const SESS = "sess_l2_off";

  s.add({
    sessionId: SESS,
    summary: "auth module work",
    regionText: "the auth module validates the session token and refreshes it on each request",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "auth module work",
    regionText: "the auth module validates the session token and refreshes it on each request",
    timestamp: 2,
  });
  assert.equal(r2.deduped, true, "L0 still catches exact dup with L2 off");
  assert.equal(r2.reason, "contentHash", "L0 contentHash still fires");

  const r3 = s.add({
    sessionId: SESS,
    summary: "auth module work variant",
    regionText: "the auth module validates the session tokens and refreshes them on each requests",
    timestamp: 3,
  });
  assert.equal(r3.deduped, true, "L1 still catches near-dup with L2 off");
  assert.equal(r3.reason, "l1MinHash", "L1 MinHash still fires");
});

test("12d. All tiers disabled — nothing deduped, everything stored", () => {
  const s = store({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: false });
  const SESS = "sess_all_off";

  const r1 = s.add({
    sessionId: SESS,
    summary: "alpha",
    regionText: "alpha region text about the compiler optimization pipeline first pass",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "alpha",
    regionText: "alpha region text about the compiler optimization pipeline second pass",
    timestamp: 2,
  });

  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, false, "all tiers off → nothing deduped");
  assert.equal(vectorList(s, SESS).length, 2, "both stored");
});
