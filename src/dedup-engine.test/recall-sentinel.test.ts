/**
 * recall-sentinel.test.ts — recallAndInline skipInjected + manual markInjected.
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vectorSearch, vectorWasInjected, vectorMarkInjected, type VectorStore } from "../vectorStore.js";
import * as recallMod from "../recall.js";
import { makeStore, makeMsg, compactFull } from "./_helpers.js";

interface RecallInjectResult {
  toInject: unknown[];
  empty: boolean;
}

const recallAndInline = (recallMod as any).recallAndInline as
  | ((
      opts: {
        sessionId: string;
        query: string;
        limit?: number;
        source: "command";
        skipInjected?: boolean;
      },
      store: VectorStore,
    ) => RecallInjectResult)
  | undefined;describe("Recall & Dedup Sentinel", () => {
  const SESS = "sess_recall";

  it("recallAndInline returns toInject on first call and empty on second due to skipInjected", () => {
    const s = makeStore();
    const region = "detailed work on the vector store dedup sentinel and recall pipeline";
    compactFull(s, SESS, [makeMsg("user", region)]);

    assert.ok(
      recallAndInline,
      "recallAndInline should be exported from recall.js for this test",
    );

    const r1 = recallAndInline!(
      {
        sessionId: SESS,
        query: "dedup sentinel recall",
        limit: 3,
        source: "command",
        skipInjected: true,
      },
      s,
    );
    assert.ok(r1.toInject.length > 0, "first recall should return hits to inject");

    const r2 = recallAndInline!(
      {
        sessionId: SESS,
        query: "dedup sentinel recall",
        limit: 3,
        source: "command",
        skipInjected: true,
      },
      s,
    );
    assert.ok(r2.empty, "second recall should be empty because sentinel marked injected");
  });

  it("manual markInjected creates skip behavior when recallAndInline is unavailable", () => {
    const s = makeStore();
    const region = "manual sentinel tracking without recallAndInline";
    compactFull(s, SESS, [makeMsg("user", region)]);

    const hits = vectorSearch(s, SESS, "manual sentinel", 3);
    assert.ok(hits.length > 0, "search should return checkpoint");
    const cpId = hits[0].checkpoint.checkpointId;
    assert.equal(vectorWasInjected(s,SESS, cpId), false, "not yet injected");

    vectorMarkInjected(s,SESS, cpId);
    assert.equal(vectorWasInjected(s,SESS, cpId), true, "markInjected recorded");

    const hits2 = vectorSearch(s, SESS, "manual sentinel", 3).filter(
      (h) => !vectorWasInjected(s,SESS, h.checkpoint.checkpointId),
    );
    assert.equal(hits2.length, 0, "filtered search excludes injected checkpoint");
  });
});
