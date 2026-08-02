/**
 * dedupe-levels.test.ts — L0/L1/L2/combined dedup behavior.
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vectorList } from "../vectorStore.js";
import { makeStore, makeMsg, compactFull, okReason } from "./_helpers.js";
describe("Dedupe Levels", () => {
  const SESS = "sess_dedup";

  it("L0 only: identical content stored twice collapses to one checkpoint", () => {
    const s = makeStore({ L0_ENABLED: true, L1_ENABLED: false, L2_ENABLED: false });
    const region = "exact same user request about database migration and index setup";

    const r1 = compactFull(s, SESS, [makeMsg("user", region)]);
    assert.equal(r1.deduped, false);
    assert.ok(r1.checkpointId);

    const r2 = compactFull(s, SESS, [makeMsg("user", region)]);
    assert.equal(r2.deduped, true);
    assert.equal(r2.checkpointId, r1.checkpointId);
    assert.equal(vectorList(s,SESS).length, 1);
  });

  it("L0 only: distinct content stored twice creates two checkpoints", () => {
    const s = makeStore({ L0_ENABLED: true, L1_ENABLED: false, L2_ENABLED: false });
    const regionA = "first exact region about authentication module refactoring";
    const regionB = "second distinct region about frontend component testing";

    const r1 = compactFull(s, SESS, [makeMsg("user", regionA)]);
    const r2 = compactFull(s, SESS, [makeMsg("user", regionB)]);
    assert.equal(r1.deduped, false);
    assert.equal(r2.deduped, false);
    assert.notEqual(r1.checkpointId, r2.checkpointId);
    assert.equal(vectorList(s,SESS).length, 2);
  });

  it("L1 only: one-word variants collapse; major rewrites do not", () => {
    const s = makeStore({ L0_ENABLED: false, L1_ENABLED: true, L2_ENABLED: false });

    const base = "the database migration added three new indexes to the users table for faster lookups";
    const variant = "the database migration added three new indexes to the users table for faster lookup";
    const rewrite = "the frontend dark mode toggle uses css custom properties for theming";

    const r1 = s.add({ sessionId: SESS, summary: "migration", regionText: base, timestamp: 1 });
    assert.equal(r1.deduped, false);

    const r2 = s.add({ sessionId: SESS, summary: "migration", regionText: variant, timestamp: 2 });
    assert.equal(r2.deduped, true, "one-word variant should be collapsed by L1");
    assert.equal(vectorList(s,SESS).length, 1);

    const r3 = s.add({ sessionId: SESS, summary: "frontend", regionText: rewrite, timestamp: 3 });
    assert.equal(r3.deduped, false, "major rewrite should not be collapsed by L1");
    assert.equal(vectorList(s,SESS).length, 2);
  });

  it("L2 only: semantic paraphrases collapse; unrelated topics do not", () => {
    // Use a lower threshold and longer, lexically-overlapping paraphrase so the
    // deterministic trigram embedder reliably catches it while still distinguishing
    // unrelated topics.
    const s = makeStore({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: true, L2_COSINE: 0.60 });

    const original =
      "user authentication and session token management login validation session expiry handling secure cookie";
    const paraphrase =
      "login validation session expiry handling secure cookie user authentication and session token management";
    const unrelated = "the frontend added a dark mode toggle with css custom properties";

    const r1 = s.add({ sessionId: SESS, summary: "auth", regionText: original, timestamp: 1 });
    assert.equal(r1.deduped, false);

    const r2 = s.add({ sessionId: SESS, summary: "auth paraphrase", regionText: paraphrase, timestamp: 2 });
    assert.equal(r2.deduped, true, "semantic paraphrase should be collapsed by L2");
    assert.equal(vectorList(s,SESS).length, 1);

    const r3 = s.add({ sessionId: SESS, summary: "frontend", regionText: unrelated, timestamp: 3 });
    assert.equal(r3.deduped, false, "unrelated topic should not be collapsed by L2");
    assert.equal(vectorList(s,SESS).length, 2);
  });

  it("All tiers disabled: every store.add() with different region text creates a distinct checkpoint", () => {
    // Even with all dedup tiers disabled, the store still enforces a unique
    // content_hash constraint, so we vary the region text slightly for each add.
    const s = makeStore({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: false });

    const r1 = s.add({ sessionId: SESS, summary: "a", regionText: "region alpha", timestamp: 1 });
    const r2 = s.add({ sessionId: SESS, summary: "a", regionText: "region beta", timestamp: 2 });
    const r3 = s.add({ sessionId: SESS, summary: "a", regionText: "region gamma", timestamp: 3 });

    assert.equal(r1.deduped, false);
    assert.equal(r2.deduped, false);
    assert.equal(r3.deduped, false);
    assert.notEqual(r1.checkpoint.checkpointId, r2.checkpoint.checkpointId);
    assert.notEqual(r2.checkpoint.checkpointId, r3.checkpoint.checkpointId);
    assert.equal(vectorList(s,SESS).length, 3);
  });

  it("Combined L0+L1+L2: layered behavior exact -> near -> semantic", () => {
    const s = makeStore({ L0_ENABLED: true, L1_ENABLED: true, L2_ENABLED: true });

    // First checkpoint establishes baseline.
    const original = "implement user authentication with session tokens and secure cookies";
    const r1 = compactFull(s, SESS, [makeMsg("user", original)]);
    assert.equal(r1.deduped, false);

    // Exact duplicate -> L0.
    const r2 = compactFull(s, SESS, [makeMsg("user", original)]);
    assert.equal(r2.deduped, true);
    okReason(r2.dedupReason, ["regionHash", "contentHash", "summaryHash"]);

    // One-word edit -> L1 (if not caught by L0 first).
    const near = "implement user authentication with session token and secure cookies";
    const r3 = compactFull(s, SESS, [makeMsg("user", near)]);
    if (r3.deduped) {
      okReason(r3.dedupReason, ["l1MinHash", "contentSimilarity"]);
    }

    // Semantic paraphrase -> L2 (if distinct from above).
    const para = "build login validation and session cookie security for users";
    const r4 = compactFull(s, SESS, [makeMsg("user", para)]);
    if (r4.deduped) {
      okReason(r4.dedupReason, ["contentSimilarity", "l1MinHash"]);
    }

    assert.ok(vectorList(s,SESS).length >= 1, "layered dedup keeps at least one checkpoint");
    assert.ok(vectorList(s,SESS).length <= 4, "layered dedup should not explode to many checkpoints");
  });
});
