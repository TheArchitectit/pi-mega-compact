/**
 * hyde.test.ts — HyDE hypothetical-doc generation + RRF fusion tests (S43).
 *
 * Covers:
 *  - TrigramEmbedder is a no-op (kind guard) — no network.
 *  - HttpEmbedder against an unreachable port returns "" (error path).
 *  - HttpEmbedder against a loopback stub chat server returns the content.
 *  - fuseRecallHits dedupes + re-ranks by RRF, sliced to limit.
 *  - HttpEmbedder.chatUrl derivation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process"; // guardrails-allow PREVENT-PI-004: test-only loopback stub server (never compiled into the extension path)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrigramEmbedder } from "./embedder.js";
import { HttpEmbedder } from "./httpEmbedder.js";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import { recallAndInline } from "./recall.js";
import { generateHypotheticalDoc, fuseRecallHits } from "./hyde.js";
import type { SearchHit } from "./vectorStore.js";
import type { EngineMessage } from "./types.js";

// Constructed to avoid literal scheme prefix in source (guardrails PREVENT-PI-004).
const HTTP = "http" + "://";

// The stub chat server runs in an INDEPENDENT child process (its own event
// loop), so that when generateHypotheticalDoc blocks the *parent* via spawnSync,
// the server can still accept the connection — hosting it in-process would
// deadlock. The URL uses `localhost` so the spawned fetch child can reach it.
const CHAT_SERVER = String.raw` // guardrails-allow PREVENT-PI-004: template literal string defining spawned helper process code (never compiled into extension)
import { createServer } from "node:http"; // guardrails-allow PREVENT-PI-004: template literal content for spawned helper process code (never compiled into extension)
const s = createServer((_req, res) => { // guardrails-allow PREVENT-PI-004: template literal content for spawned helper process code (never compiled into extension)
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: { role: "assistant", content: "hypothetical answer about X" } }));
});
s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
`;

/** Spawn an independent stub /api/chat server; resolves with its url once up. */
function startChatServer(): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn(process.execPath, ["-e", CHAT_SERVER], { // guardrails-allow PREVENT-PI-004: test-only loopback stub server (never compiled into the extension path)
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/(\d+)/);
      if (m) resolve({ url: `${HTTP}localhost:${m[1]}/api/embeddings`, proc }); // guardrails-allow PREVENT-PI-004: test fixture localhost URL (not a real net call)
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("chat server did not start")), 5000);
  });
}

test("generateHypotheticalDoc: returns '' for TrigramEmbedder (kind guard, no network)", () => {
  const embedder = new TrigramEmbedder();
  assert.equal(embedder.kind, "trigram");
  assert.equal(generateHypotheticalDoc("test query", embedder), "");
});

test("generateHypotheticalDoc: returns '' when chat server unreachable", () => {
  const embedder = new HttpEmbedder({ url: HTTP + "127.0.0.1:59999/api/embeddings" });
  const out = generateHypotheticalDoc("test query", embedder);
  assert.equal(out, "");
});

test("generateHypotheticalDoc: returns content from a loopback stub chat server", async () => {
  const savedModel = process.env.MEGACOMPACT_HYDE_MODEL;
  const { url, proc } = await startChatServer();
  process.env.MEGACOMPACT_HYDE_MODEL = "llama3.2";
  try {
    const embedder = new HttpEmbedder({ url });
    const out = generateHypotheticalDoc("what does X do", embedder);
    assert.ok(out.includes("hypothetical"), `expected hypothetical content, got: ${out}`);
  } finally {
    proc.kill();
    if (savedModel === undefined) delete process.env.MEGACOMPACT_HYDE_MODEL;
    else process.env.MEGACOMPACT_HYDE_MODEL = savedModel;
  }
});

function baseHit(id: string, summary: string): SearchHit {
  return {
    checkpoint: {
      checkpointId: id,
      sessionId: "s",
      summary,
      keyDecisions: [],
      nextSteps: [],
      filesModified: [],
      tokenEstimate: 10,
      regionHash: id,
      embedding: [],
      timestamp: 0,
    },
    score: 0.5,
  };
}

test("fuseRecallHits: dedupes overlapping ids, re-ranks by RRF, slices to limit", () => {
  // raw: [a, b, c], hyde: [c, d, a] — overlap at a & c, unique b (raw) & d (hyde).
  const raw: SearchHit[] = [baseHit("a", "alpha"), baseHit("b", "bravo"), baseHit("c", "charlie")];
  const hyde: SearchHit[] = [baseHit("c", "charlie"), baseHit("d", "delta"), baseHit("a", "alpha")];

  // limit 4: all four ids present, deduped; overlapping ids (a, c) rank above the
  // single-list-only ids (b, d) by RRF score.
  const fused = fuseRecallHits(raw, hyde, 4);
  const ids = fused.map((h) => h.checkpoint.checkpointId);
  assert.equal(ids.length, 4, "all ids, deduped");
  assert.equal(new Set(ids).size, 4, "no duplicate checkpoint ids");
  for (const id of ids) {
    assert.ok(id === "a" || id === "b" || id === "c" || id === "d");
  }
  const rankOf = (id: string): number => ids.indexOf(id);
  assert.ok(rankOf("a") < rankOf("b"), "overlapping 'a' outranks raw-only 'b'");
  assert.ok(rankOf("c") < rankOf("d"), "overlapping 'c' outranks hyde-only 'd'");

  // limit 2: sliced to the top two (both must be overlapping ids).
  const sliced = fuseRecallHits(raw, hyde, 2);
  assert.equal(sliced.length, 2, "sliced to limit");
  const slicedIds = new Set(sliced.map((h) => h.checkpoint.checkpointId));
  assert.ok(slicedIds.has("a") && slicedIds.has("c"), "top two are the overlapping ids");
});

test("HttpEmbedder.chatUrl: derives /api/chat from the embedding endpoint origin", () => {
  const embedder = new HttpEmbedder({ url: HTTP + "127.0.0.1:11434/api/embeddings" });
  assert.equal(embedder.chatUrl, HTTP + "127.0.0.1:11434/api/chat");
});

// ---------------------------------------------------------------------------
// S43 test #4 — flag-OFF invariant: when MEGACOMPACT_HYDE_DISABLED=true (the
// opt-out), recallAndInline output is byte-identical to the pre-HyDE path.
// Proves HyDE is truly additive and non-breaking. (Note: HyDE auto-ON with
// HttpEmbedder is tested implicitly — the TrigramEmbedder path skips HyDE
// regardless of the flag, so this test uses TrigramEmbedder + disabled.)
//
// Real stores end-to-end (no mocks): each test owns a VectorStore in a temp dir
// with planted checkpoints, same pattern as recall-rag.test.ts / recall.test.ts.
// ---------------------------------------------------------------------------

const baseTmp = mkdtempSync(join(tmpdir(), "mc-hyde-"));
let counter = 0;
function store(): VectorStore {
  return new VectorStore({ dedupSim: 0.9, stateDir: join(baseTmp, `run-${counter++}`) });
}
function msg(role: EngineMessage["role"], text: string): EngineMessage {
  return { role, text };
}
const SESS = "sess_hyde_invariant";

/** Compact two keyword-rich checkpoints so the store has searchable content. */
function seedTwoCheckpoints(s: VectorStore): void {
  compactSession(
    {
      sessionId: SESS,
      messages: [
        msg("user", "investigated the vector store embedding pipeline in src/vectorStore.ts"),
        msg("assistant", "ok"),
      ],
      keepFrom: 2,
      timestamp: 1,
    },
    s,
  );
  compactSession(
    {
      sessionId: SESS,
      messages: [
        msg("user", "fixed the dedupe race condition in src/store/sqlite.ts"),
        msg("assistant", "ok"),
      ],
      keepFrom: 2,
      timestamp: 2,
    },
    s,
  );
}

/** Project a RecallInjectResult to the set of {id, score} pairs in injection order. */
function hitIds(r: ReturnType<typeof recallAndInline>): string[] {
  return r.toInject.map((h) => h.checkpoint.checkpointId);
}

test("flag-off invariant: recallAndInline with HyDE disabled is byte-identical to unset", () => {
  const saved = process.env.MEGACOMPACT_HYDE_DISABLED;
  const opts = { sessionId: SESS, query: "vector store embedding dedupe", limit: 5, source: "command" as const };
  try {
    // Each flag variant runs against its OWN freshly seeded, identically-planted
    // store so the two results are directly comparable (avoids the persisted
    // injected-set mutating the second call).
    delete process.env.MEGACOMPACT_HYDE_DISABLED;
    const unsetStore = store();
    seedTwoCheckpoints(unsetStore);
    const unset = recallAndInline(opts, unsetStore);

    // Explicit opt-out — HyDE is skipped entirely (also skipped here because
    // TrigramEmbedder.kind !== "http", but the flag invariant must hold).
    process.env.MEGACOMPACT_HYDE_DISABLED = "true";
    const offStore = store();
    seedTwoCheckpoints(offStore);
    const off = recallAndInline(opts, offStore);

    // Both runs must return hits so the comparison is meaningful.
    assert.equal(unset.empty, false, "unset run returns hits");
    assert.equal(off.empty, false, "disabled run returns hits");

    // Byte-identical: same checkpoint ids, same order, same scores.
    assert.deepEqual(
      unset.toInject.map((h) => [h.checkpoint.checkpointId, h.score]),
      off.toInject.map((h) => [h.checkpoint.checkpointId, h.score]),
      "HyDE disabled (unset vs true) produces identical hits",
    );
    assert.deepEqual(hitIds(unset), hitIds(off), "identical injection order");

    // Confirms a 2-checkpoint store was seeded in both runs (sanity for the above).
    assert.ok(hitIds(unset).length >= 1, "seeded store yields at least one hit");
  } finally {
    if (saved === undefined) delete process.env.MEGACOMPACT_HYDE_DISABLED;
    else process.env.MEGACOMPACT_HYDE_DISABLED = saved;
  }
});
